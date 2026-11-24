import {
  AV_BASE, ADMIN, DEV, SOLO, PEOPLE, WORKSPACES, WS_REPOS,
  INITIAL_PROJECTS, INITIAL_SESSIONS, INITIAL_PEERS, INITIAL_TASKS,
  INITIAL_KNOWLEDGE, INITIAL_PROPOSALS, INITIAL_REQUESTS,
  SYS_MAP, MEM, PLAYBOOKS, ADMIN_DATA
} from './data.js';

(function () {
  'use strict';

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || String(p || '');
  const icon = (name, size = 15) => `<svg class="od-icon" style="--od-icon-size:${size}px" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  function av(id, size = 24) {
    const p = PEOPLE[id];
    if (p && p.avatar) {
      return `<img class="av" src="${AV_BASE}${p.avatar}" alt="${esc(p.name)}" style="--av:${size}px">`;
    }
    const ch = (p && p.name ? p.name[0] : '?');
    return `<span class="av" style="--av:${size}px;display:grid;place-items:center;font-size:${Math.max(10, Math.round(size * .45))}px;font-weight:600;color:var(--fg-2)">${esc(ch)}</span>`;
  }

  /* ═══ 核心状态 ═══ */
  const state = {
    me: ADMIN,
    theme: 'light',
    accent: 'violet',
    density: 'standard',
    zoom: 1,
    nav: 'chat',            /* 'chat' | 'inbox' | 'board' | 'knowledge' | 'playbooks' | 'admin' */
    adminView: 'gateway',   /* 'appearance' | 'memory' | 'diagnostics' | 'roles' | 'repos' | 'gateway' | 'skills' | 'audit' */
    sideOpen: true,
    drawerOpen: false,
    railOpen: typeof window !== 'undefined' ? window.innerWidth > 1060 : true,
    railW: 320,
    dockTab: 'files',       /* 'files' | 'changes' | 'artifacts' */
    artMode: 'render',      /* 'render' | 'source' */
    ws: 'ws-base',
    proj: 'p-checkout',
    workTab: 'personal',    /* 'personal' | 'team' */
    newPubProj: null,
    landingId: null,
    session: 's-priv-1',    /* null 时展示零弹窗欢迎起步页 */
    newTeam: 'ws-base',
    newDir: '~/work/pay/checkout-split',
    cross: null,            /* { owner, id } */
    synced: {},
    returnTo: null,
    dirOpen: {},
    collabOpen: {},
    openTools: {},
    ctxOpen: false,
    preview: null,          /* { tabs: [], active: '' } */
    ptab: 'code',
    drafts: {},
    busySim: false,         /* 模拟 Agent 输出中：用于体验排队/引导托盘 */
    queueHeld: false,
    queued: [
      { id: 'q-demo-1', text: '顺便检查一下 `job/compensate.ts` 有没有跳过 retryAfterMs 校验' }
    ],
    atq: null,
    atIdx: 0,
    palQ: '',
    palIdx: 0,
    approvalDecisions: {},
    mutedSuggestions: {},
    activePromptIdx: 0,
    shouldScrollEnd: false,

    inboxTab: 'todo',
    inboxType: 'all',
    inboxSel: null,

    boardProj: 'all',
    boardScope: 'mine',
    boardView: 'status',
    boardOnlyIssues: false,
    taskSel: null,

    kscope: 'all',
    kSel: null,
    selectedMapRepo: null,
    propMode: 'supplement',

    projects: clone(INITIAL_PROJECTS),
    sessions: clone(INITIAL_SESSIONS),
    peers: clone(INITIAL_PEERS),
    tasks: clone(INITIAL_TASKS),
    knowledge: clone(INITIAL_KNOWLEDGE),
    proposals: clone(INITIAL_PROPOSALS),
    requests: clone(INITIAL_REQUESTS)
  };

  /* ═══ 业务查询辅助 ═══ */
  const NO_TEAM = { id: null, name: '无团队', members: [], roles: {} };
  const wsById = (id) => WORKSPACES.find((w) => w.id === id) || NO_TEAM;
  const curWs = () => wsById(state.ws);
  const projById = (id) => state.projects.find((p) => p.id === id) || null;
  const curProj = () => projById(state.proj) || { id: null, name: '个人工作台', members: [], repo: '' };
  const teamRole = (wsId, pid) => {
    const w = wsById(wsId);
    return w.members.includes(pid) ? (w.roles[pid] || '开发者') : '';
  };
  const isAdmin = (wsId) => teamRole(wsId, state.me) === '管理员';
  const projectAccess = (p) => !!(p && teamRole(p.ws, state.me) && p.members.includes(state.me));
  const wsProjects = () => state.projects.filter((p) => p.ws === state.ws && projectAccess(p));
  const accessibleProjects = () => state.projects.filter((p) => projectAccess(p));
  const publishTargetsFor = (s) => accessibleProjects().filter((p) => !s?.team || p.ws === s.team);
  const mySessions = () => state.sessions.filter((s) => s.owner === state.me);
  const curSession = () => mySessions().find((s) => s.id === state.session) || null;
  const peersOf = (projId) => state.peers.filter((p) => p.proj === projId && p.owner !== state.me);
  const peerById = (id) => state.peers.find((p) => p.id === id) || null;
  const curPeer = () => (state.cross ? peerById(state.cross.id) : null);
  const snapKey = (p) => `${state.me}:${p.owner}:${p.id}`;
  const peerSynced = (p) => !!state.synced[snapKey(p)];
  const sessionNeedsApproval = (s) => !!((s && s.msgs) || []).some((m) => m.w === 'approval' && m.state !== 'resolved' && !state.approvalDecisions[m.id]);
  const WS_DOT = ['#7b61ff', '#0284c7', '#d97706', '#059669'];

  function wsDot(wsId) {
    if (!wsId) return '';
    const idx = WORKSPACES.findIndex((w) => w.id === wsId);
    if (idx < 0) return '';
    const left = !teamRole(wsId, state.me);
    return `<span class="team-dot${left ? ' left' : ''}" style="--td:${WS_DOT[idx % WS_DOT.length]}" title="${left ? '已离开团队' : '团队上下文：' + esc(wsById(wsId).name)}"></span>`;
  }

  function badge(label, tone = 'neutral', extra = '') {
    return `<span class="hui-badge${extra ? ' ' + extra : ''}" data-tone="${tone}">${tone === 'info' ? '<span class="hui-lamp"></span>' : ''}${esc(label)}</span>`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  /* ═══ Inbox 数据汇总 ═══ */
  function inboxItems() {
    const todo = [], sent = [];
    state.tasks.forEach((t) => {
      const pj = projById(t.proj);
      if (!projectAccess(pj)) return;
      const src = `${t.src === 'session' ? '对话 @ 派发' : '看板派发'} · ${pj.name}`;
      if (t.to === state.me && t.status === 'open') {
        todo.push({ key: 'task:' + t.id, type: 'task', ref: t, ws: pj.ws, title: t.title, who: t.from, src, time: t.time });
      } else if (t.from === state.me && t.to !== state.me) {
        sent.push({ key: 'task:' + t.id, type: 'task', ref: t, ws: pj.ws, title: t.title, who: t.to, src, time: t.time, st: STATUS_TEXT[t.status] });
      }
    });
    state.proposals.forEach((p) => {
      if (!teamRole(p.ws, state.me) || p.status === 'published') return;
      const item = {
        key: 'prop:' + p.id, type: p.kind === 'map' ? 'map' : 'prop', ref: p, ws: p.ws,
        title: p.title, who: p.author, src: (p.kind === 'map' ? '系统地图提议' : '知识审核') + ' · ' + (LEVEL_TEXT[p.level] || '经验'), time: p.time
      };
      if (p.status === 'pending' && isAdmin(p.ws)) todo.push(item);
      if (p.author === state.me) sent.push({ ...item, st: p.status === 'rejected' ? '已退回' : '待审核' });
    });
    state.requests.forEach((r) => {
      const item = {
        key: 'req:' + r.id, type: r.kind, ref: r, ws: r.ws,
        title: r.kind === 'join' ? `申请加入 ${wsById(r.ws).name}` : `申请成为${r.role}`,
        who: r.from, src: wsById(r.ws).name, time: r.time
      };
      if (r.status === 'pending' && isAdmin(r.ws) && r.from !== state.me) todo.push(item);
      if (r.from === state.me) sent.push({ ...item, st: r.status === 'pending' ? '待处理' : '已处理' });
    });
    return { todo, sent };
  }
  const inboxCount = () => inboxItems().todo.length;

  const STATUS_TEXT = { open: '待接受', claimed: '待开始', running: '进行中', done: '已完成', declined: '已拒绝' };
  const LEVEL_TEXT = { rule: '规约', exp: '经验', term: '术语', map: '系统地图' };
  const LEVEL_TONE = { rule: 'accent', exp: 'info', term: 'neutral', map: 'success' };

  /* ═══ 第一层：56px 固定全局图标栏 ═══ */
  function renderRailBar() {
    const hasTeam = !!teamRole(state.ws, state.me);
    const ibN = hasTeam ? inboxCount() : 0;
    const peerUpd = hasTeam && state.peers.some((p) => p.owner !== state.me && p.sync === 'updated' && projectAccess(projById(p.proj)));
    const navItems = [
      { id: 'chat', label: 'AI 工作台（个人 & 协作会话）', ic: 'home', dot: peerUpd },
      { id: 'inbox', label: 'Inbox · 跨人待办与审批', ic: 'inbox', count: ibN },
      { id: 'board', label: 'Project 看板与任务', ic: 'board' },
      { id: 'knowledge', label: '团队知识与系统地图', ic: 'book' },
      { id: 'playbooks', label: 'Playbook 模板与未来 SOP 扩展位', ic: 'workflow' }
    ];
    const buttons = navItems.map((it) => {
      const on = state.nav === it.id;
      return `<button type="button" class="rail-btn${on ? ' is-active' : ''}" data-act="rail-nav" data-nav="${it.id}" title="${it.label}" aria-label="${it.label}"${on ? ' aria-current="page"' : ''}>` +
        icon(it.ic, 18) +
        (it.count ? `<span class="rail-badge">${it.count}</span>` : (it.dot && !on ? '<span class="rail-dot"></span>' : '')) +
      `</button>`;
    }).join('');

    const adminOn = state.nav === 'admin';
    $('#lfRail').innerHTML =
      `<div class="lf-brand-mark" title="Harness Code · 协作工作台双层交互原型">${icon('sparkles', 17)}</div>` +
      `<nav class="rail-nav" aria-label="主导航">${buttons}</nav>` +
      `<div class="rail-spacer"></div>` +
      `<div class="rail-sep" role="separator"></div>` +
      `<button type="button" class="rail-btn" data-act="palette" title="全局命令面板 (⌘K)" aria-label="全局命令面板">${icon('search', 17)}</button>` +
      `<button type="button" class="rail-btn${adminOn ? ' is-active' : ''}" data-act="rail-nav" data-nav="admin" title="管理与设置（模型网关 / MCP / 角色 / 审计）" aria-label="管理与设置">${icon('gear', 18)}</button>` +
      `<button type="button" class="rail-avatar-btn" data-act="user-pop" title="${esc(PEOPLE[state.me].name)} · 点击切换主题与演示视角" aria-label="个人账号与外观设置">` +
        av(state.me, 30) + `<span class="av-role-dot${state.me === SOLO ? ' solo' : ''}"></span></button>`;
  }

  /* ═══ 第二层：304px 悬浮卡片次级侧栏 ═══ */
  const WIDE_VIEWS = ['inbox', 'board', 'playbooks', 'knowledge'];

  function sessRow(s) {
    const active = !state.cross && s.id === state.session && state.nav === 'chat';
    const landing = state.landingId === s.id;
    const needAppr = sessionNeedsApproval(s);
    const stateIcon = s.running
      ? `<span class="sess-state-ico is-run" title="运行中">${icon('refresh', 12)}</span>`
      : (s.unread ? `<span class="sess-unread-dot" title="离开期间完成 · 未读"></span>` : '');
    return `<button type="button" class="sess-item${active ? ' is-active' : ''}${landing ? ' is-landing' : ''}" data-act="open-session" data-id="${s.id}">` +
      `<span class="sr-top"><span class="sess-title">${esc(s.title)}</span>` +
        (needAppr ? `<span class="sess-appr-tag">待批准</span>` : '') +
        stateIcon +
      `</span>` +
      `<span class="sess-meta">${wsDot(s.team)}` +
        (s.shareProject ? `<span class="sess-me-tag">我</span>` : '') +
        (s.shareProject && s.shareMode === 'summary' ? `<span>仅摘要</span>` : '') +
        `<span>${esc(s.time)}</span>` +
        (s.extraDirs.length ? `<span>· +${s.extraDirs.length}目录</span>` : '') +
      `</span></button>`;
  }

  function peerRow(p) {
    const on = state.cross && state.cross.id === p.id;
    return `<button type="button" class="cp-row${on ? ' is-active' : ''}" data-act="open-peer" data-owner="${p.owner}" data-id="${p.id}">` +
      `<span class="cp-top">${av(p.owner, 18)}<span class="cp-title">${esc(p.title)}</span>` +
        (p.sync === 'updated' && !peerSynced(p) ? '<span class="unsync-dot" title="有新上传"></span>' : '') +
      `</span>` +
      `<span class="cp-meta"><span>${esc(PEOPLE[p.owner].name)}</span><span>·</span><span>${esc(p.time)}</span></span></button>`;
  }

  function renderSecondarySidebar() {
    const app = $('#app');
    const isWide = WIDE_VIEWS.includes(state.nav);
    const hideSide = isWide || !state.sideOpen;
    app.classList.toggle('no-sidebar', hideSide);
    const sb = $('#sidebar');
    if (isWide) { sb.innerHTML = ''; return; }

    if (state.nav === 'admin') {
      const groups = [
        {
          label: '个人与本机',
          items: [
            { id: 'appearance', label: '外观、缩放与快捷键', ic: 'sun' },
            { id: 'memory', label: '本机记忆 (team / personal)', ic: 'brain', dot: MEM.personal.some((m) => m.conflict) },
            { id: 'diagnostics', label: '脱敏诊断包 (HC-254)', ic: 'alert' }
          ]
        },
        {
          label: '团队与组织',
          items: [
            { id: 'roles', label: '成员角色与离职交接 (HC-240)', ic: 'users' },
            { id: 'repos', label: 'Workspace 仓库目录', ic: 'folder' }
          ]
        },
        {
          label: '企业资产与治理',
          items: [
            { id: 'gateway', label: '企业模型网关与配额 (HC-244)', ic: 'server' },
            { id: 'skills', label: '团队 Skills 与受控 MCP (HC-245)', ic: 'skills' },
            { id: 'audit', label: '共享脱敏与组织审计 (HC-249)', ic: 'shield' }
          ]
        }
      ];
      sb.innerHTML =
        `<div class="sb-head"><span class="sb-head-title">管理与设置</span>` +
          `<button type="button" class="btn btn-soft btn-xs" data-act="rail-nav" data-nav="chat">${icon('back', 12)}返回工作台</button></div>` +
        `<div class="sb-scroll">` +
          groups.map((g) => `<div class="nav-group-label">${g.label}</div>` + g.items.map((it) => {
            const on = state.adminView === it.id;
            return `<button type="button" class="nav-item${on ? ' is-active' : ''}" data-act="admin-nav" data-id="${it.id}">` +
              icon(it.ic, 15) + `<span class="nav-label">${it.label}</span>` +
              (it.dot ? '<span class="sb-mem-dot" title="有待核对冲突"></span>' : '') +
            `</button>`;
          }).join('')).join('') +
        `</div>`;
      return;
    }

    /* 工作台会话模式：方案 A —— 304px 侧栏内「个人 | 团队」严格分栏 */
    const mineAll = mySessions();
    const privList = mineAll.filter((s) => !s.shareProject);
    const sharedList = mineAll.filter((s) => !!s.shareProject);
    const hasTeam = !!teamRole(state.ws, state.me);
    const peerUpd = hasTeam && state.peers.some((p) => p.owner !== state.me && p.sync === 'updated' && projectAccess(projById(p.proj)));
    const isTeamTab = state.workTab === 'team';

    let tabBody = '';
    if (!isTeamTab) {
      const groups = [];
      privList.forEach((s) => {
        const d = s.mainDir || '未选目录';
        let g = groups.find((x) => x.dir === d);
        if (!g) { g = { dir: d, items: [] }; groups.push(g); }
        g.items.push(s);
      });
      const privHtml = !privList.length
        ? `<p class="meta" style="padding:10px">暂无个人会话，右侧可直接输入开聊。</p>`
        : groups.map((g) => {
            const open = state.dirOpen[g.dir] !== false;
            return `<div>` +
              `<button type="button" class="grp-head${open ? '' : ' is-closed'}" data-act="toggle-dir" data-dir="${esc(g.dir)}">` +
                `<span class="chev">${icon('chev', 11)}</span>${icon('folder', 13)}` +
                `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(baseName(g.dir))}</span>` +
                `<span class="n">${g.items.length}</span></button>` +
              `<div class="grp-collapse" data-open="${open ? '1' : '0'}"><div class="grp-collapse-inner">${g.items.map(sessRow).join('')}</div></div>` +
            `</div>`;
          }).join('');
      tabBody =
        `<div class="sb-actions">` +
          `<button type="button" class="btn btn-primary btn-sm" data-act="new-welcome">${icon('pen', 14)}<span>新建个人会话</span></button>` +
          `<button type="button" class="icon-btn" data-act="palette" title="全局搜索 (⌘K)">${icon('search', 15)}</button>` +
        `</div>` +
        `<div class="sb-scroll">` +
          `<div class="sb-block-head"><span>我的个人会话（按工程目录）</span><span class="sb-block-act meta">${privList.length}</span></div>` +
          privHtml +
          (sharedList.length ? `<p class="sb-foot-note">另有 ${sharedList.length} 个会话已发布到 Project，在「团队」页签下。</p>` : '') +
        `</div>`;
    } else if (!hasTeam) {
      tabBody =
        `<div class="sb-scroll"><div class="panel" style="margin:10px 4px;padding:12px;gap:8px">` +
          `<span style="font-size:12.5px;font-weight:600">当前账号未加入团队</span>` +
          `<span class="meta">个人会话与本机 Agent 不受影响。切换演示视角即可体验团队协作。</span>` +
          `<button type="button" class="btn btn-soft btn-sm" data-act="switch-me" data-id="${ADMIN}">切换到张景新（管理员）</button>` +
        `</div></div>`;
    } else {
      const ws = curWs();
      const projs = wsProjects();
      const teamListHtml = projs.map((p) => {
        const open = (p.id in state.collabOpen) ? state.collabOpen[p.id] : p.id === state.proj;
        const mine = sharedList.filter((s) => s.shareProject === p.id);
        const peers = peersOf(p.id);
        const inner = mine.map(sessRow).join('') + peers.map(peerRow).join('') || `<p class="meta" style="padding:4px 14px">暂无已发布会话</p>`;
        return `<div class="cp-proj">` +
          `<div class="cp-proj-row">` +
            `<button type="button" class="grp-head${open ? '' : ' is-closed'}" data-act="toggle-proj" data-id="${p.id}">` +
              `<span class="chev">${icon('chev', 11)}</span>` +
              `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>` +
              `<span class="n">${mine.length + peers.length}</span></button>` +
            `<button type="button" class="icon-btn cp-gear" data-act="open-proj-info" data-id="${p.id}" title="Project 资料与成员">${icon('sliders', 13)}</button>` +
          `</div>` +
          `<div class="grp-collapse" data-open="${open ? '1' : '0'}"><div class="grp-collapse-inner">${inner}</div></div>` +
        `</div>`;
      }).join('');
      tabBody =
        `<div class="sb-actions">` +
          `<button type="button" class="btn btn-primary btn-sm" data-act="new-proj-welcome">${icon('plus', 14)}<span>新建协作会话</span></button>` +
          `<button type="button" class="icon-btn" data-act="palette" title="全局搜索 (⌘K)">${icon('search', 15)}</button>` +
        `</div>` +
        `<div class="sb-scroll">` +
          `<button type="button" class="ws-pill-btn" data-act="ws-menu" aria-haspopup="menu">` +
            wsDot(ws.id) + `<span class="ws-pill-name">${esc(ws.name)}</span>` +
            `<span class="meta">${esc(teamRole(ws.id, state.me))}</span>${icon('chev', 12)}` +
          `</button>` +
          `<div class="sb-block-head"><span>Project 协作会话</span><span class="sb-block-act meta">${sharedList.length} 我 / ${projs.reduce((n, p) => n + peersOf(p.id).length, 0)} 队友</span></div>` +
          teamListHtml +
          `<button type="button" class="nav-item" style="margin-top:6px" data-act="new-project">${icon('plus', 14)}<span class="nav-label">新建 Project</span></button>` +
        `</div>`;
    }

    sb.innerHTML =
      `<div class="sb-head"><span class="sb-head-title">工作台</span>` +
        `<button type="button" class="icon-btn" data-act="side-toggle" title="收起侧栏 (⌘\\)">${icon('panel-left', 15)}</button></div>` +
      `<div class="sb-seg-wrap"><div class="sb-seg" role="tablist" aria-label="会话空间">` +
        `<button type="button" role="tab" class="${!isTeamTab ? 'is-active' : ''}" data-act="work-tab" data-id="personal" aria-selected="${!isTeamTab}">` +
          `${icon('user', 13)}<span>个人</span><span class="seg-count">${privList.length}</span></button>` +
        `<button type="button" role="tab" class="${isTeamTab ? 'is-active' : ''}" data-act="work-tab" data-id="team" aria-selected="${isTeamTab}">` +
          `${icon('users', 13)}<span>团队</span>${peerUpd ? '<span class="sp-dot" title="队友会话有更新"></span>' : ''}</button>` +
      `</div></div>` +
      tabBody +
      `<div class="sb-foot">` +
        `<button type="button" class="nav-item" data-act="admin-jump" data-id="memory">${icon('brain', 15)}<span class="nav-label">本机记忆 (team / personal)</span>` +
          (MEM.personal.some((m) => m.conflict) ? '<span class="sb-mem-dot" title="有 1 处路径映射待核对"></span>' : '') + `</button>` +
      `</div>`;
  }

  /* ═══ 顶栏 ═══ */
  function renderTopbar() {
    const isWide = WIDE_VIEWS.includes(state.nav);
    const tg = $('#sideToggle');
    if (tg) {
      tg.hidden = isWide;
      tg.innerHTML = icon('panel-left', 16);
      tg.classList.toggle('is-on', state.sideOpen);
    }
    $('#drawerBtn').innerHTML = icon('menu', 18);

    const bh = $('#backHomeBtn');
    const showBack = !!state.cross || (state.returnTo && state.nav !== 'chat');
    bh.hidden = !showBack;
    bh.innerHTML = showBack ? icon('back', 16) : '';

    const peer = curPeer();
    const s = curSession();
    let titleHtml = '';
    if (peer) {
      titleHtml = `${av(peer.owner, 22)}<span class="tb-name">${esc(PEOPLE[peer.owner].name)} · ${esc(peer.title)}</span>` +
        badge(peerSynced(peer) ? '已同步 · 只读' : '未同步简报 · 只读', peerSynced(peer) ? 'muted' : 'accent');
    } else if (state.nav === 'chat') {
      if (!s) {
        titleHtml = `<span class="tb-name">新对话准备区</span>` + badge('零弹窗 · 直接输入即可开始', 'accent');
      } else {
        titleHtml = `<span class="tb-name">${esc(s.title)}</span>` +
          `<button type="button" class="tb-dir" data-act="open-dirs" title="管理主目录与附加目录">${icon('folder', 12)}<span>${esc(baseName(s.mainDir))}</span>` +
            (s.extraDirs.length ? `<span>+${s.extraDirs.length}</span>` : '') + `${icon('chev', 11)}</button>` +
          (s.shareProject ? badge('Project 可见 · ' + esc(projById(s.shareProject)?.name || ''), 'accent') : badge('仅本人本机', 'muted')) +
          (s.running || state.busySim ? badge('运行中', 'info') : '');
      }
    } else {
      const mapTitle = {
        inbox: ['Inbox · 待办与审批', `${inboxCount()} 项待你拍板`],
        board: ['Project 任务看板', `${curWs().name || '未加入团队'}`],
        knowledge: ['团队知识与系统地图', `${curWs().name || '未加入团队'}`],
        playbooks: ['Playbook 模板与 SOP 扩展位', 'Workspace 审核模板 + 未来交付流水线预览'],
        admin: ['管理与设置', '个人偏好 / 成员交接 / 企业网关 / 审计']
      }[state.nav] || ['工作台', ''];
      titleHtml = `<span class="tb-name">${esc(mapTitle[0])}</span><span class="tb-crumb">${esc(mapTitle[1])}</span>`;
    }
    $('#tbTitle').innerHTML = titleHtml;

    const proj = curProj();
    const showCollab = state.nav === 'chat' && s && s.shareProject && proj.id && teamRole(state.ws, state.me);
    $('#tbCollab').innerHTML = showCollab
      ? `<button type="button" class="collab-btn" data-act="member-peek">` +
          `<span class="av-stack">${proj.members.filter((m) => m !== state.me).slice(0, 3).map((m) => av(m, 20)).join('')}</span>` +
          `<span>${proj.members.length} 人协作</span>${icon('chev', 12)}</button>`
      : '';

    const canRail = state.nav === 'chat' && !peer && !!s;
    $('#tbRight').innerHTML =
      (state.nav === 'chat' && !peer && s ? `<button type="button" class="btn btn-soft btn-xs" data-act="toggle-busy-sim" title="模拟 Agent 正在回复，体验排队与引导托盘">${state.busySim ? '停止模拟运行' : '模拟运行中(排队/引导)'}</button>` : '') +
      `<button type="button" class="icon-btn" data-act="toggle-theme" title="切换浅色/深色">${icon(state.theme === 'dark' ? 'sun' : 'moon', 16)}</button>` +
      `<button type="button" class="icon-btn${canRail && state.railOpen ? ' is-on' : ''}" data-act="toggle-rail" ${canRail ? '' : 'disabled'} title="${canRail ? '展开/收起右侧工作区' : '仅本机会话显示右侧工作区'}">${icon('panel', 16)}</button>`;
  }

  /* ═══ 对话工作台（含零弹窗首页 + 时间线 + 排队托盘） ═══ */
  function tlText(t) {
    return esc(t).replace(/`([^`]+)`/g, '<code class="tl-inline">$1</code>')
      .replace(/@《([^》]+)》\s?(v[\d.]+)?/g, (_, title, ver) => `<button type="button" class="tl-chip is-know" data-act="goto-know" data-title="${title}">@《${title}》${ver || ''}</button>`);
  }

  function renderTimeline(msgs) {
    let pIdx = 0;
    return (msgs || []).map((m, idx) => {
      const key = `${state.session || 'p'}:${idx}`;
      if (m.w === 'thinking') {
        const open = !!state.openTools[key];
        return `<div class="tl-body"><button type="button" class="tl-disc" data-act="toggle-tool" data-tid="${key}" aria-expanded="${open}">` +
          `${icon('brain', 14)}<span class="tl-disc-main"><span class="tl-disc-t">${esc(m.label)}</span><span class="tl-disc-s">${esc(m.dur || '')}</span></span>` +
          `<span class="tl-caret">${icon('chev-right', 12)}</span></button>` +
          `<div class="tl-collapse" data-open="${open ? '1' : '0'}"><div class="tl-collapse-inner tl-details">${(m.body || []).map((b) => `<p>${tlText(b)}</p>`).join('')}</div></div></div>`;
      }
      if (m.w === 'workgroup') {
        const open = !!state.openTools[key];
        return `<div class="tl-body"><button type="button" class="tl-disc" data-act="toggle-tool" data-tid="${key}" aria-expanded="${open}">` +
          `${icon('terminal', 14)}<span class="tl-disc-main"><span class="tl-disc-t">${esc(m.title)}</span><span class="tl-disc-s">${esc(m.dur || '')} · ${esc(m.summary || '')}</span></span>` +
          `<span class="tl-caret">${icon('chev-right', 12)}</span></button>` +
          `<div class="tl-collapse" data-open="${open ? '1' : '0'}"><div class="tl-collapse-inner tl-rows">${(m.rows || []).map((r, ri) => {
            const rk = `${key}:r${ri}`;
            const ropen = !!state.openTools[rk];
            return `<div><button type="button" class="tl-wbtn" data-act="${r.file ? 'open-file' : 'toggle-tool'}" data-file="${esc(r.file || '')}" data-tid="${rk}">` +
              `${icon(r.ic || 'terminal', 13)}<span class="tl-verb">${esc(r.verb)}</span><span class="tl-target">${esc(r.target)}</span>` +
              (r.badge ? badge(r.badge, r.tone || 'neutral', 'xs') : '') + `</button>` +
              (r.out && !r.file ? `<div class="tl-collapse" data-open="${ropen ? '1' : '0'}"><div class="tl-collapse-inner"><pre class="tl-out-pre">${esc(r.out)}</pre></div></div>` : '') +
            `</div>`;
          }).join('')}</div></div></div>`;
      }
      if (m.w === 'approval') {
        const dec = state.approvalDecisions[m.id];
        return `<div class="tl-appr${!dec ? ' is-pending' : ''}">` +
          `<div class="c4-bar" style="justify-content:space-between"><span class="c4-bar">${icon('shield', 15)}<strong>${esc(m.kind)}</strong></span>` +
            badge(dec ? (dec === 'denied' ? '已拒绝' : '已批准执行') : '等待你审批', dec ? (dec === 'denied' ? 'danger' : 'success') : 'warn') + `</div>` +
          `<pre class="tl-appr-code">${esc(m.code)}</pre>` +
          `<p class="meta">${esc(m.reason)}</p>` +
          (!state.cross && !dec ? `<div class="c4-bar"><button type="button" class="btn btn-primary btn-sm" data-act="approve" data-id="${m.id}" data-dec="once">批准本次操作</button><button type="button" class="btn btn-danger btn-sm" data-act="approve" data-id="${m.id}" data-dec="denied">拒绝</button></div>` : '') +
        `</div>`;
      }
      if (m.w === 'diag') {
        const open = !!state.openTools[key];
        return `<div class="tl-diag is-fail">` +
          `<div class="c4-bar" style="justify-content:space-between"><span class="c4-bar">${icon('alert', 15)}<strong>${esc(m.title)}</strong></span>` +
            badge(m.code, 'danger', 'mono') + `</div>` +
          `<p style="font-size:var(--text-sm)">${esc(m.message)}</p>` +
          `<p class="meta">${esc(m.suggestion)}</p>` +
          `<div class="c4-bar"><button type="button" class="btn btn-secondary btn-xs" data-act="toggle-tool" data-tid="${key}">${open ? '收起诊断字段' : '查看脱敏详情'}</button>` +
            `<button type="button" class="btn btn-soft btn-xs" data-act="copy-diag" data-idx="${idx}">${icon('copy', 12)}复制诊断 JSON</button>` +
            `<button type="button" class="btn btn-ghost btn-xs" data-act="admin-jump" data-id="gateway">检查企业网关 →</button></div>` +
          `<div class="tl-collapse" data-open="${open ? '1' : '0'}"><div class="tl-collapse-inner"><pre class="tl-out-pre">${esc(JSON.stringify(m.detail, null, 2))}</pre></div></div>` +
        `</div>`;
      }
      if (m.w === 'reference') {
        return `<div class="c4-card"><div class="c4-bar" style="justify-content:space-between">${badge('来自 ' + esc(PEOPLE[m.from]?.name || '队友') + ' 的跨机引用', 'accent')}<span class="meta">已解析到本机</span></div>` +
          `<p style="font-size:var(--text-sm)"><strong>${esc(m.raw)}</strong> — ${esc(m.said)}</p>` +
          `<span class="meta mono">↓ ${esc(m.local)}</span></div>`;
      }
      if (m.w === 'agent') {
        const html = (m.blocks || []).map((b) => {
          if (b.t === 'ul') return `<ul>${b.items.map((x) => `<li>${tlText(x)}</li>`).join('')}</ul>`;
          return `<p>${tlText(b.text)}</p>`;
        }).join('');
        return `<div class="tl-body"><div class="tl-who"><span class="tl-name">Harness Agent</span>${m.model ? badge(m.model, 'muted', 'xs') : ''}</div>` +
          `<div class="tl-prose">${html}</div>` +
          (m.files && m.files.length ? `<div class="c4-bar">${m.files.map((f) => `<button type="button" class="tl-chip" data-act="open-file" data-file="${esc(f.n)}" data-diff="1">${icon('git', 11)}${esc(f.n)} <span style="color:var(--success-fg)">+${f.add}</span> <span style="color:var(--danger-fg)">-${f.del}</span></button>`).join('')}</div>` : '') +
          `<div class="tl-agent-foot"><button type="button" class="tl-foot-btn" data-act="quote-reply" data-idx="${idx}">${icon('reply', 12)}引用追问</button><span class="meta">${esc(m.time || '')}</span></div></div>`;
      }
      pIdx++;
      return `<div class="tl-user" data-prompt-idx="${pIdx - 1}"><div class="tl-user-box">` +
        `<div class="tl-user-who"><span>${esc(PEOPLE[m.w]?.name || '我')}</span><span>${esc(m.time || '')}</span></div>` +
        `<div class="tl-user-bubble">${tlText(m.text)}</div>` +
        (m.ctx ? `<div class="tl-ctx">${m.ctx.map((c) => `<button type="button" class="tl-chip is-know" data-act="goto-know" data-title="${esc(c.know || c.t)}">${icon('book', 11)}${esc(c.t)} ${esc(c.ver || '')}</button>`).join('')}</div>` : '') +
      `</div></div>`;
    }).join('');
  }

  function renderComposer(s, isWelcome = false) {
    const teamId = s ? s.team : (teamRole(state.newTeam, state.me) ? state.newTeam : null);
    const hasTeam = !!(teamId && teamRole(teamId, state.me));
    const draftKey = s ? s.id : '__welcome__';
    const draft = esc(state.drafts[draftKey] || '');
    const showQueue = !!(s && (state.busySim || state.queued.length));
    const queueHtml = showQueue && state.queued.length
      ? `<div class="queued-tray" aria-label="排队中的消息">` +
          (state.queueHeld ? `<div class="queued-note"><span>已暂停自动发送</span><button type="button" class="btn btn-soft btn-xs" data-act="queue-resume">继续发送</button></div>` : '') +
          state.queued.map((q) => `<div class="queued-row">${icon('queue', 13)}<span class="queued-text">${esc(q.text)}</span>` +
            `<button type="button" class="queued-steer" data-act="queue-steer" data-id="${q.id}" title="打断当前回复，保留已输出内容并立即发送">${icon('redo', 11)}${state.busySim ? '引导' : '发送'}</button>` +
            `<button type="button" class="icon-btn" style="width:24px;height:24px" data-act="queue-del" data-id="${q.id}" title="删除">${icon('trash', 12)}</button></div>`).join('') +
        `</div>`
      : '';

    const ctxBar = s && hasTeam
      ? `<div class="ctx-inline"><button type="button" class="ctx-toggle" data-act="toggle-ctx" aria-expanded="${state.ctxOpen}">` +
          `${icon('chev-right', 12)}<span>本轮自动注入：1 条规约正文 · ${state.knowledge.filter((k) => k.ws === teamId).length} 条知识目录 · team.md / personal.md</span>` +
          (MEM.personal.some((m) => m.conflict) ? `<span class="hui-badge" data-size="xs" data-tone="warn" style="margin-left:auto">1 处待核对</span>` : '') +
        `</button>` +
        `<div class="ctx-collapse" data-open="${state.ctxOpen ? '1' : '0'}"><div class="ctx-collapse-inner ctx-drawer">` +
          `<div class="ctx-item"><strong>规约直带（范围匹配）</strong><p class="meta">《接口错误码与金额整数分规约》v2.1</p></div>` +
          `<div class="ctx-item"><strong>标题目录（按需读取）</strong><p class="meta">经验、术语与系统地图 v1.4（8 KiB 预算内）</p></div>` +
          `<div class="ctx-item"><strong>本机双层记忆（${esc(wsById(teamId).name)}）</strong><p class="meta">team.md + personal.md 完整附带</p></div>` +
        `</div></div></div>`
      : '';

    const ctxPills = isWelcome
      ? `<div class="c4-bar" style="margin-bottom:6px">` +
          `<button type="button" class="tb-dir" data-act="welcome-dir">${icon('folder', 12)}<span>目录：${esc(state.newDir)}</span></button>` +
          (state.newPubProj
            ? badge('将发布到 Project：' + esc(projById(state.newPubProj)?.name || ''), 'accent') +
              `<button type="button" class="btn btn-ghost btn-xs" data-act="new-welcome">改为个人会话</button>`
            : `<select class="c4-select" data-role="welcome-team" style="height:26px;font-size:12px" aria-label="选择团队上下文">` +
                `<option value=""${!state.newTeam ? ' selected' : ''}>无团队（纯本机探索）</option>` +
                WORKSPACES.filter((w) => teamRole(w.id, state.me)).map((w) => `<option value="${w.id}"${state.newTeam === w.id ? ' selected' : ''}>团队：${esc(w.name)}</option>`).join('') +
              `</select>`) +
        `</div>`
      : '';

    const atHtml = state.atq !== null ? renderAtMenu(s, teamId) : '';
    return `<div class="composer-wrap"><div class="composer-inner">${atHtml}${ctxPills}${ctxBar}${queueHtml}` +
      `<div class="composer">` +
        `<textarea id="composer" data-role="composer" rows="2" placeholder="${isWelcome ? '直接描述你想做的事，发送首条消息自动开启本机会话（Enter 发送）…' : (state.busySim ? 'Agent 正在执行中：现在输入并发送会进入上方排队托盘…' : '输入指令，输入 @ 引用团队知识或 @成员派任务…')}">${draft}</textarea>` +
        `<div class="composer-bar">` +
          (hasTeam ? `<button type="button" class="at-pill-btn" data-act="open-at">${icon('at', 13)}<span>引用 / @派任务</span></button>` : '') +
          `<span class="meta">${state.busySim ? '生成中 · 发送将进入排队托盘' : '只在本机执行 · Enter 发送'}</span>` +
          `<button type="button" class="send-btn" data-act="send-msg" title="发送">${icon('arrow-up', 15)}</button>` +
        `</div>` +
      `</div></div></div>`;
  }

  function renderAtMenu(s, teamId) {
    const q = (state.atq || '').toLowerCase();
    const kList = state.knowledge.filter((k) => k.ws === teamId && (!q || k.title.toLowerCase().includes(q)));
    const proj = s && s.shareProject ? projById(s.shareProject) : null;
    const members = proj ? proj.members.filter((m) => m !== state.me && (!q || PEOPLE[m].name.includes(q))) : [];
    return `<div class="at-menu" id="atMenu" role="listbox">` +
      `<div class="at-group-head">团队知识（锁定当前发布版本）</div>` +
      (kList.length ? kList.map((k) => `<button type="button" class="at-item" data-act="pick-at-know" data-id="${k.id}">${icon('book', 14)}<span>${esc(k.title)}</span><span class="at-ver">${esc(k.version)}</span></button>`).join('') : `<p class="meta" style="padding:4px 8px">无匹配知识</p>`) +
      `<div class="at-group-head">@成员 派发任务</div>` +
      (members.length ? members.map((m) => `<button type="button" class="at-item" data-act="pick-at-person" data-id="${m}">${av(m, 16)}<span>${esc(PEOPLE[m].name)}</span><span class="at-ver">派任务</span></button>`).join('') : `<p class="meta" style="padding:4px 8px">${proj ? '无匹配成员' : '会话发布到 Project 后可 @成员'}</p>`) +
    `</div>`;
  }

  function viewChat() {
    const s = curSession();
    if (!s) {
      return `<div class="chat-wrap"><div class="chat"><div class="chat-scroll"><div class="home-welcome">` +
        `<div class="home-brand-row"><div class="home-logo">${icon('sparkles', 24)}</div><div><h1>你好，${esc(PEOPLE[state.me].name)}</h1><p class="sub">无需先建 Project 或弹窗填表——选好本机目录，直接开始个人会话或套用 Playbook。</p></div></div>` +
        `<div class="pb-quick-grid">${PLAYBOOKS.map((pb) => `<button type="button" class="pb-quick-card" data-act="apply-playbook" data-id="${pb.id}">` +
          `<div class="c4-bar" style="justify-content:space-between">${badge(pb.kind, pb.status === '未来扩展位' ? 'warn' : 'accent', 'xs')}<span class="meta mono">${esc(pb.version)}</span></div>` +
          `<strong>${esc(pb.title)}</strong><span>${esc(pb.desc)}</span></button>`).join('')}</div>` +
      `</div></div>${renderComposer(null, true)}</div></div>`;
    }

    const prompts = (s.msgs || []).filter((m) => !['thinking', 'workgroup', 'approval', 'diag', 'reference', 'agent'].includes(m.w));
    const minimap = prompts.length >= 2
      ? `<aside class="tl-minimap" aria-label="Prompt 导航">${prompts.map((p, i) => `<button type="button" class="tl-mm-item${i === state.activePromptIdx ? ' is-active' : ''}" data-act="jump-prompt" data-idx="${i}"><span class="tl-mm-bar"></span><span class="tl-mm-pop"><span class="tl-mm-pop-meta">Prompt ${i + 1}</span><span class="tl-mm-pop-u">${esc(p.text)}</span></span></button>`).join('')}</aside>`
      : '';

    const headBar = `<div class="c4-chat-head"><div class="c4-bar">` +
        (s.team && teamRole(s.team, state.me) ? badge('团队知识：' + esc(wsById(s.team).name), 'accent') : badge('无团队上下文', 'muted')) +
        (s.shareProject && s.shareMode === 'summary' ? badge('仅共享状态与成果摘要', 'info') : '') +
        (s.extraDirs.length ? badge(`主目录 + ${s.extraDirs.length} 附加目录`, 'neutral') : '') +
      `</div><div class="c4-bar">` +
        (s.shareProject
          ? `<button type="button" class="btn btn-secondary btn-xs" data-act="stop-share">停止共享</button>`
          : (publishTargetsFor(s).length ? `<button type="button" class="btn btn-soft btn-xs" data-act="share-to-proj">发布到 Project…</button>` : '')) +
        (s.team && teamRole(s.team, state.me) ? `<button type="button" class="btn btn-secondary btn-xs" data-act="open-draft">${icon('book', 12)}沉淀为团队知识</button>` : '') +
      `</div></div>`;

    const chatHtml = `<div class="chat">${headBar}${minimap}<div class="chat-scroll" id="chatScroll"><div class="chat-inner">${renderTimeline(s.msgs)}</div></div>${renderComposer(s, false)}</div>`;
    if (!state.preview) return `<div class="chat-wrap">${chatHtml}</div>`;
    return `<div class="chat-wrap"><div class="chat-split">${chatHtml}${renderFilePane()}</div></div>`;
  }

  function renderFilePane() {
    const pv = state.preview;
    const lines = [
      'export async function handleRefundCallback(req: RefundCallback) {',
      '  const gate = await idemGateway.acquire(req.orderId, req.refundNo);',
      '  if (!gate.acquired) return { code: 409, retryAfterMs: 1500 };',
      '  return transitionState(req.orderId, "REFUNDED");',
      '}'
    ];
    return `<section class="filepane"><div class="filepane-head">` +
      pv.tabs.map((t) => `<button type="button" class="fp-tab${t === pv.active ? ' is-active' : ''}" data-act="open-file" data-file="${esc(t)}">${esc(baseName(t))}</button>`).join('') +
      `<span class="vb-spacer"></span>` +
      `<button type="button" class="btn btn-ghost btn-xs" data-act="toggle-ptab">${state.ptab === 'diff' ? '看源码' : '看 Diff'}</button>` +
      `<button type="button" class="icon-btn" style="width:24px;height:24px" data-act="close-filepane">${icon('x', 13)}</button>` +
    `</div><div class="filepane-body">${lines.map((l, i) => `<div class="code-line${state.ptab === 'diff' && i === 2 ? ' is-add' : ''}"><span class="ln">${i + 1}</span><span>${esc(state.ptab === 'diff' && i === 2 ? '+ ' + l : l)}</span></div>`).join('')}</div></section>`;
  }

  /* ═══ 跨机只读会话 + 异步批注（HC-252） ═══ */
  function viewPeer() {
    const p = curPeer();
    if (!p) return '';
    const synced = peerSynced(p);
    const notesHtml = (p.notes || []).map((n) => `<div class="c4-card"><div class="c4-bar">${av(n.who, 20)}<strong>${esc(PEOPLE[n.who].name)}</strong><span class="meta">${esc(n.time)}</span>${badge('异步批注', 'info', 'xs')}</div><p style="font-size:var(--text-sm)">${esc(n.text)}</p></div>`).join('');

    const brief = `<div class="brief-card"><div class="c4-bar" style="justify-content:space-between"><div class="c4-bar">${av(p.owner, 32)}<div><strong>${esc(PEOPLE[p.owner].name)} 的共享会话</strong><p class="meta">${esc(projById(p.proj)?.name || '')} · ${esc(p.time)}</p></div></div>` +
      (synced ? badge('已同步只读快照', 'success') : `<button type="button" class="btn btn-primary btn-sm" data-act="sync-peer">${icon('sync', 14)}同步正文</button>`) +
    `</div><p style="font-size:var(--text-base)">${esc(p.brief)}</p><ul style="margin:0;padding-left:18px;font-size:var(--text-sm);color:var(--fg-2)">${p.points.map((x) => `<li>${tlText(x)}</li>`).join('')}</ul></div>`;

    return `<div class="chat-wrap"><div class="chat"><div class="chat-scroll"><div class="chat-inner">${brief}` +
      (synced ? renderTimeline(p.msgs) : `<div class="c4-card"><span class="meta">点击右上角「同步正文」拉取定稿对话，不会启动对方电脑或读取对方实时文件。</span></div>`) +
      `<div class="panel"><div class="panel-head"><h2>异步批注（HC-252 · 进对方 Inbox，不触发对方 Agent）</h2></div>${notesHtml || '<p class="meta">暂无批注</p>'}` +
        `<div class="c4-bar"><input type="text" id="peerNoteInput" placeholder="留下评审意见或联调字段说明…" style="flex:1;padding:7px 10px;border:none;border-radius:var(--radius-sm);background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--border)">` +
        `<button type="button" class="btn btn-soft btn-sm" data-act="add-peer-note">发送批注</button></div></div>` +
    `</div></div><div class="peer-foot"><div class="peer-foot-inner">${icon('lock', 13)}<span class="meta">跨机只读模式 · 无对话输入框</span><span class="vb-spacer"></span>` +
      `<button type="button" class="btn btn-secondary btn-sm" data-act="cite-peer">${icon('copy', 13)}引用到我的本机会话</button>` +
      `<button type="button" class="btn btn-primary btn-sm" data-act="dispatch-from-peer">${icon('at', 13)}@成员 派发任务</button></div></div></div></div>`;
  }

  /* ═══ 宽屏视图：Inbox / 看板 / 知识与地图 / Playbook·SOP / 管理台 ═══ */
  function viewInbox() {
    if (!teamRole(state.ws, state.me)) {
      return `<div class="page-wrap"><div class="empty-block"><strong>未加入团队</strong><p class="meta">跨人异步审批仅在加入团队后可用，本机权限审批留在原会话。</p></div></div>`;
    }
    const all = inboxItems();
    const tab = state.inboxTab === 'sent' ? 'sent' : 'todo';
    const list = (all[tab] || []).filter((it) => state.inboxType === 'all' || (state.inboxType === 'know' ? (it.type === 'prop' || it.type === 'map') : (state.inboxType === 'member' ? (it.type === 'join' || it.type === 'role') : it.type === state.inboxType)));
    if (list.length && !list.some((x) => x.key === state.inboxSel)) state.inboxSel = list[0].key;
    const cur = list.find((x) => x.key === state.inboxSel) || null;

    const detailHtml = !cur ? '' : (cur.type === 'task'
      ? `<article class="k-doc"><div class="c4-bar">${badge('任务指派', 'accent')}<span>${esc(cur.src)}</span></div><h2>${esc(cur.title)}</h2><p>${esc(cur.ref.desc)}</p>` +
          (tab === 'todo' ? `<div class="c4-bar"><button type="button" class="btn btn-primary btn-sm" data-act="claim-task" data-id="${cur.ref.id}">接受任务</button><button type="button" class="btn btn-danger btn-sm" data-act="decline-task" data-id="${cur.ref.id}">拒绝</button><button type="button" class="btn btn-secondary btn-sm" data-act="jump-board" data-id="${cur.ref.id}">在看板打开</button></div>` : `<button type="button" class="btn btn-secondary btn-sm" data-act="jump-board" data-id="${cur.ref.id}">在看板查看进度</button>`) +
        `</article>`
      : (cur.type === 'prop' || cur.type === 'map'
        ? `<article class="k-doc"><div class="c4-bar">${badge(cur.type === 'map' ? '系统地图提议' : '知识提议', 'info')}${badge(LEVEL_TEXT[cur.ref.level] || '经验', 'neutral')}<span>${esc(cur.ref.applies)}</span></div><h2>${esc(cur.title)}</h2><p class="meta">来源：${esc(cur.ref.source)}</p>` +
            `<div class="diff">${cur.ref.diff.map((d) => `<div class="diff-row ${d.t === 'add' ? 'is-add' : (d.t === 'del' ? 'is-del' : '')}"><span>${d.t === 'add' ? '+' : (d.t === 'del' ? '-' : ' ')}</span><span>${esc(d.x)}</span></div>`).join('')}</div>` +
            (tab === 'todo' && isAdmin(cur.ws) ? `<div class="c4-bar"><button type="button" class="btn btn-primary btn-sm" data-act="prop-approve" data-id="${cur.ref.id}">批准并发布新版本</button><button type="button" class="btn btn-danger btn-sm" data-act="prop-reject" data-id="${cur.ref.id}">退回</button></div>` : `<p class="meta">只有 Workspace 管理员可执行审核发布。</p>`) +
          `</article>`
        : `<article class="k-doc"><div class="c4-bar">${badge('成员与权限', 'warn')}</div><h2>${esc(PEOPLE[cur.who].name)} ${esc(cur.title)}</h2><p>${esc(cur.ref.note)}</p>` +
            (tab === 'todo' && isAdmin(cur.ws) ? `<div class="c4-bar"><button type="button" class="btn btn-primary btn-sm" data-act="req-approve" data-id="${cur.ref.id}">同意</button><button type="button" class="btn btn-danger btn-sm" data-act="req-reject" data-id="${cur.ref.id}">拒绝</button></div>` : '') +
          `</article>`));

    return `<div class="page-wrap">` +
      `<div class="page-head"><div><h1>Inbox · 全局待办收件箱</h1><p>收口跨人任务指派、团队知识/系统地图审核与角色申请；本机授权审批留在原会话。</p></div>` +
        `<div class="seg">${[['todo', `待我处理 ${all.todo.length}`], ['sent', `我发起的 ${all.sent.length}`]].map((t) => `<button type="button" class="${tab === t[0] ? 'is-active' : ''}" data-act="inbox-tab" data-id="${t[0]}">${t[1]}</button>`).join('')}</div></div>` +
      `<div class="view-bar">${[['all', '全部'], ['task', '任务'], ['know', '知识与地图'], ['member', '成员角色']].map((f) => `<button type="button" class="btn ${state.inboxType === f[0] ? 'btn-soft' : 'btn-secondary'} btn-sm" data-act="inbox-type" data-id="${f[0]}">${f[1]}</button>`).join('')}</div>` +
      (!list.length ? `<div class="empty-block"><strong>当前列表为空</strong><p class="meta">无待处理的跨人异步事项。</p></div>` : `<div class="review-layout"><div class="k-side">${list.map((it) => `<button type="button" class="k-row${it.key === cur.key ? ' is-active' : ''}" data-act="inbox-sel" data-id="${esc(it.key)}"><span class="kr-title">${esc(it.title)}</span><span class="kr-meta">${badge(it.type === 'task' ? '任务' : (it.type === 'map' ? '地图' : (it.type === 'prop' ? '知识' : '权限')), 'neutral', 'xs')}<span>${esc(PEOPLE[it.who].name)}</span><span>·</span><span>${esc(it.time)}</span></span></button>`).join('')}</div>${detailHtml}</div>`) +
    `</div>`;
  }

  function viewBoard() {
    if (!teamRole(state.ws, state.me)) {
      return `<div class="page-wrap"><div class="empty-block"><strong>未加入团队</strong><p class="meta">Project 看板在加入团队后展示。</p></div></div>`;
    }
    const list = state.tasks.filter((t) => {
      const p = projById(t.proj);
      if (!p || p.ws !== state.ws || !projectAccess(p)) return false;
      if (state.boardProj !== 'all' && t.proj !== state.boardProj) return false;
      if (state.boardScope === 'mine' && t.to !== state.me) return false;
      if (state.boardScope === 'all' && state.boardOnlyIssues && !(t.status === 'declined' || (t.stale && t.status !== 'done'))) return false;
      return true;
    });
    const cols = [{ st: 'open', l: '待接受' }, { st: 'claimed', l: '待开始' }, { st: 'running', l: '进行中' }, { st: 'done', l: '已完成' }];
    const card = (t) => `<article class="tcard${state.taskSel === t.id ? ' is-active' : ''}"><button type="button" class="tcard-main" data-act="task-open" data-id="${t.id}"><span class="t-title">${esc(t.title)}</span><span class="t-meta">${av(t.to, 18)}<span>${esc(PEOPLE[t.to].name)}</span>${t.stale && t.status !== 'done' ? badge(t.stale, 'warn', 'xs') : ''}${t.live ? badge('本机运行中', 'info', 'xs') : ''}</span></button>` +
      (t.to === state.me && t.status === 'open' ? `<div class="tcard-acts"><button type="button" class="btn btn-primary btn-xs" data-act="claim-task" data-id="${t.id}">接受</button><button type="button" class="btn btn-secondary btn-xs" data-act="decline-task" data-id="${t.id}">拒绝</button></div>` :
       t.to === state.me && t.status === 'claimed' ? `<div class="tcard-acts"><button type="button" class="btn btn-primary btn-xs" data-act="start-task" data-id="${t.id}">在本机开始</button></div>` : '') +
    `</article>`;

    const body = state.boardScope === 'all' && state.boardView === 'member'
      ? `<div class="mboard"><div class="mb-row mb-head"><span class="mb-who">成员</span>${cols.map((c) => `<span class="mb-cell">${c.l}</span>`).join('')}</div>` +
        curWs().members.map((m) => `<div class="mb-row"><span class="mb-who">${av(m, 24)}<strong>${esc(PEOPLE[m].name)}</strong></span>${cols.map((c) => `<div class="mb-cell">${list.filter((t) => t.to === m && t.status === c.st).map(card).join('') || '<span class="meta">—</span>'}</div>`).join('')}</div>`).join('') + `</div>`
      : `<div class="board">${cols.map((c) => {
          const items = list.filter((t) => t.status === c.st);
          return `<div class="col"><div class="col-head"><span>${c.l}</span><span class="c-count">${items.length}</span></div>${items.map(card).join('') || '<p class="meta">暂无任务</p>'}</div>`;
        }).join('')}</div>`;

    const curT = state.taskSel ? state.tasks.find((t) => t.id === state.taskSel) : null;
    const drawer = curT ? `<div class="t-drawer-backdrop" data-act="task-close"></div><aside class="t-drawer"><button type="button" class="icon-btn t-drawer-x" data-act="task-close">${icon('x', 15)}</button>` +
      `<div class="od-stack" style="--od-gap:10px">${badge(STATUS_TEXT[curT.status], curT.status === 'done' ? 'success' : (curT.status === 'running' ? 'info' : 'warn'))}<h2>${esc(curT.title)}</h2><p style="font-size:var(--text-sm)">${esc(curT.desc)}</p>` +
      `<div class="panel" style="padding:12px"><span class="meta">结构化交付物摘要（HC-247）</span><strong style="font-size:var(--text-sm)">${esc(curT.deliverable)}</strong></div>` +
      (curT.to === state.me && curT.status === 'claimed' ? `<button type="button" class="btn btn-primary" data-act="start-task" data-id="${curT.id}">${icon('send', 14)}选择本机目录开始</button>` : '') +
      `</div></aside>` : '';

    return `<div class="page-wrap"><div class="page-head"><div><h1>Project 看板</h1><p>在无侧栏宽屏下查看个人任务流或团队成员泳道，个人未发布会话不会出现在这里。</p></div>` +
      `<button type="button" class="btn btn-primary btn-sm" data-act="new-task">${icon('plus', 14)}新建并指派任务</button></div>` +
      `<div class="view-bar">` +
        `<div class="seg">${[['mine', '我的'], ['all', '团队总览']].map((o) => `<button type="button" class="${state.boardScope === o[0] ? 'is-active' : ''}" data-act="board-scope" data-id="${o[0]}">${o[1]}</button>`).join('')}</div>` +
        (state.boardScope === 'all' ? `<div class="seg">${[['status', '状态四列'], ['member', '成员泳道']].map((o) => `<button type="button" class="${state.boardView === o[0] ? 'is-active' : ''}" data-act="board-view" data-id="${o[0]}">${o[1]}</button>`).join('')}</div>` : '') +
        `<select class="c4-select" data-role="board-proj"><option value="all"${state.boardProj === 'all' ? ' selected' : ''}>全部 Project</option>${wsProjects().map((p) => `<option value="${p.id}"${state.boardProj === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` +
      `</div>${body}${drawer}</div>`;
  }

  function viewKnowledge() {
    if (!teamRole(state.ws, state.me)) {
      return `<div class="page-wrap"><div class="empty-block"><strong>未加入团队</strong><p class="meta">团队知识库与系统地图属于 Workspace。</p></div></div>`;
    }
    const pendN = state.proposals.filter((p) => p.ws === state.ws && p.status === 'pending').length;
    const filters = [['all', '全部已发布'], ['rule', '规约'], ['exp', '经验'], ['term', '术语'], ['map', '系统地图']];
    let bodyHtml = '';
    if (state.kscope === 'map') {
      const repos = SYS_MAP.repos.filter((r) => (WS_REPOS[state.ws] || []).includes(r.name));
      const W = 680, H = 260;
      const pos = {};
      repos.forEach((r, i) => { pos[r.name] = { x: 120 + (i % 3) * 210, y: 72 + Math.floor(i / 3) * 120 }; });
      const edges = repos.flatMap((r) => r.rel.map((rel) => {
        const a = pos[r.name], b = pos[rel.to];
        if (!a || !b) return '';
        return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--border-strong)" stroke-width="1.5" ${rel.sure ? '' : 'stroke-dasharray="4 3"'} />`;
      })).join('');
      const nodes = repos.map((r) => {
        const p = pos[r.name];
        const picked = state.selectedMapRepo === r.name;
        return `<g class="map-node${picked ? ' is-picked' : ''}" data-act="pick-map" data-id="${esc(r.name)}"><rect x="${p.x - 82}" y="${p.y - 22}" width="164" height="44" rx="8" fill="var(--surface)" stroke="var(--border-strong)"/><text x="${p.x}" y="${p.y - 2}" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--fg)">${esc(r.name)}</text><text x="${p.x}" y="${p.y + 13}" text-anchor="middle" font-size="11" fill="var(--meta)">${r.local ? '本机已映射' : '本机未克隆'}</text></g>`;
      }).join('');
      bodyHtml = `<div class="map-wrap"><div class="c4-bar" style="justify-content:space-between;margin-bottom:8px"><strong>系统地图 ${SYS_MAP.version}</strong><span class="meta">实线：源码证据确认 · 虚线：推测待核实 · 点击节点筛选下方明细</span></div><svg class="map-svg" viewBox="0 0 ${W} ${H}">${edges}${nodes}</svg></div>` +
        `<div class="map-wrap"><table class="map-table"><thead><tr><th>仓库</th><th>职责</th><th>依赖关系</th><th>证据</th><th>personal.md 状态</th></tr></thead><tbody>` +
        repos.map((r) => {
          const hi = state.selectedMapRepo && (state.selectedMapRepo === r.name || r.rel.some((x) => x.to === state.selectedMapRepo));
          return `<tr class="${hi ? 'is-hi' : ''}"><td><strong>${esc(r.name)}</strong></td><td>${esc(r.duty)}</td><td>${r.rel.map((x) => `${esc(x.kind)} → ${esc(x.to)}`).join('<br>') || '—'}</td><td class="mono">${r.rel.map((x) => x.ev ? esc(x.ev) : '推测').join('<br>') || '—'}</td><td>${r.local ? badge('已映射', 'success', 'xs') + ' ' + esc(r.local) : badge('未克隆', 'warn', 'xs')}</td></tr>`;
        }).join('') + `</tbody></table></div>`;
    } else {
      const list = state.knowledge.filter((k) => k.ws === state.ws && (state.kscope === 'all' || k.level === state.kscope));
      if (list.length && !list.some((k) => k.id === state.kSel)) state.kSel = list[0].id;
      const cur = list.find((k) => k.id === state.kSel) || list[0];
      bodyHtml = `<div class="review-layout"><div class="k-side">${list.map((k) => `<button type="button" class="k-row${cur && k.id === cur.id ? ' is-active' : ''}" data-act="k-sel" data-id="${k.id}"><span class="kr-title">${esc(k.title)}</span><span class="kr-meta">${badge(LEVEL_TEXT[k.level], LEVEL_TONE[k.level], 'xs')}${badge(k.applies, 'muted', 'xs')}<span>${k.version}</span><span>· 命中 ${k.hits}</span></span></button>`).join('')}</div>` +
        (cur ? `<article class="k-doc"><div class="c4-bar" style="justify-content:space-between"><div class="c4-bar">${badge(LEVEL_TEXT[cur.level], LEVEL_TONE[cur.level])}${badge(cur.applies, 'muted')}${badge(cur.version, 'neutral', 'mono')}</div>` +
          `<div class="c4-bar"><button type="button" class="btn btn-soft btn-xs" data-act="cite-k" data-id="${cur.id}">${icon('at', 12)}引用到当前会话</button><button type="button" class="btn btn-secondary btn-xs" data-act="mark-useful" data-id="${cur.id}">有用 (${cur.useful})</button></div></div>` +
          `<h2>${esc(cur.title)}</h2><p><strong>核心约束：</strong>${esc(cur.sum)}</p><pre class="tl-out-pre" style="white-space:pre-wrap;font-family:var(--font-body)">${esc(cur.body)}</pre>` +
          `<div class="panel" style="padding:12px;background:var(--surface-2)"><strong style="font-size:12.5px">最近被 Agent 检索与命中足迹（检索可观测性）</strong>` +
            ((cur.traces || []).length ? cur.traces.map((t) => `<p class="meta">· ${esc(PEOPLE[t.who].name)} 在《${esc(t.session)}》(${t.time})：${esc(t.note)}</p>`).join('') : `<p class="meta">近期暂无命中记录</p>`) +
          `</div></article>` : '') + `</div>`;
    }

    return `<div class="page-wrap"><div class="page-head"><div><h1>团队知识与系统地图</h1><p>规约在范围匹配时自动直带；经验、术语与系统地图进目录由 Agent 按需读取。</p></div>` +
      `<div class="c4-bar">${pendN ? `<button type="button" class="btn btn-soft btn-sm" data-act="rail-nav" data-nav="inbox">待审核提议 (${pendN}) →</button>` : ''}<button type="button" class="btn btn-primary btn-sm" data-act="open-draft">${icon('plus', 14)}沉淀为团队知识</button></div></div>` +
      `<div class="view-bar"><div class="seg">${filters.map((f) => `<button type="button" class="${state.kscope === f[0] ? 'is-active' : ''}" data-act="k-scope" data-id="${f[0]}">${f[1]}</button>`).join('')}</div></div>` +
      bodyHtml + `</div>`;
  }

  function viewPlaybooks() {
    return `<div class="page-wrap"><div class="page-head"><div><h1>Playbook 模板与未来 SOP 扩展位</h1><p>借助 56px 固定导航栏，团队 Playbook（HC-251）与未来多阶段交付 SOP 可以自然生长，不挤压会话侧栏。</p></div></div>` +
      `<div class="card-grid">${PLAYBOOKS.map((pb) => `<article class="sop-card">` +
        `<div class="c4-bar" style="justify-content:space-between">${badge(pb.kind, pb.status === '未来扩展位' ? 'warn' : 'accent')}${badge(pb.version, 'muted', 'mono')}</div>` +
        `<h2 style="font-size:16px">${esc(pb.title)}</h2><p class="meta" style="font-size:13px">${esc(pb.desc)}</p>` +
        `<div class="c4-bar">${pb.dirs.map((d) => badge(baseName(d), 'neutral', 'xs mono')).join('')}</div>` +
        `<div class="sop-card-foot"><span class="meta">预置 ${pb.knowledge.length} 条知识</span>` +
          `<button type="button" class="btn btn-soft btn-sm" data-act="apply-playbook" data-id="${pb.id}">${icon('play', 12)}一键套用起聊</button></div>` +
      `</article>`).join('')}</div></div>`;
  }

  function viewAdmin() {
    const v = state.adminView;
    const head = {
      appearance: ['外观、密度与快捷键', '控制浅色/深色主题、强调色与界面缩放'],
      memory: ['本机记忆检查与纠正 (HC-233)', 'team.md 与 personal.md 只存在本人电脑，不上传云端'],
      diagnostics: ['一键脱敏诊断包 (HC-254)', '导出前自动移除模型 Key、Git Token 与隐私正文'],
      roles: ['Workspace 成员角色与离职交接 (HC-240)', '管理员可审核知识、管理仓库并交接未完结 Task'],
      repos: ['Workspace 仓库目录', '团队共有仓库登记，供系统地图与范围匹配消费'],
      gateway: ['企业模型网关与可用模型下发 (HC-244)', '免手填个人 Key，按团队/角色下发短期消费令牌与配额'],
      skills: ['团队 Skills 与受控 MCP 目录 (HC-245)', '成员提议 → 静态安全扫描 → 管理员审核启用'],
      audit: ['共享出口脱敏与组织审计日志 (HC-249)', '个人会话正文永不入组织审计，仅记录四大共享出口与关键治理动作']
    }[v] || ['设置与管理', ''];

    let inner = '';
    if (v === 'appearance') {
      inner = `<div class="panel"><div class="c4-bar" style="justify-content:space-between"><div><strong>主题模式</strong><p class="meta">浅色为默认，深色独立配色</p></div>` +
        `<div class="seg">${[['light', '浅色'], ['dark', '深色']].map((t) => `<button type="button" class="${state.theme === t[0] ? 'is-active' : ''}" data-act="set-theme" data-id="${t[0]}">${t[1]}</button>`).join('')}</div></div>` +
        `<div class="c4-bar" style="justify-content:space-between"><div><strong>强调色</strong><p class="meta">仅落主操作、激活指示线与微点</p></div>` +
        `<div class="c4-bar">${[['violet', '靛紫'], ['indigo', '靛蓝'], ['teal', '松石绿'], ['ink', '极简黑']].map((a) => `<button type="button" class="btn ${state.accent === a[0] ? 'btn-primary' : 'btn-secondary'} btn-sm" data-act="set-accent" data-id="${a[0]}">${a[1]}</button>`).join('')}</div></div>` +
        `<div class="c4-bar" style="justify-content:space-between"><div><strong>界面缩放</strong><p class="meta">小窗口与高分屏适配</p></div>` +
        `<div class="seg">${[0.9, 1, 1.1].map((z) => `<button type="button" class="${state.zoom === z ? 'is-active' : ''}" data-act="set-zoom" data-id="${z}">${Math.round(z * 100)}%</button>`).join('')}</div></div></div>`;
    } else if (v === 'memory') {
      inner = `<div class="panel"><div class="panel-head"><h2>team.md（工程别名与关系 · 仅本机）</h2>${badge('随会话完整注入', 'info')}</div>` +
        MEM.team.map((m) => `<div class="c4-bar" style="justify-content:space-between;padding:6px 0;box-shadow:inset 0 -1px var(--border-soft)"><div><strong>${esc(m.name)}</strong> <span class="meta">(${esc(m.alias)})</span><p class="meta">${esc(m.note)}</p></div>${badge(m.source, 'muted', 'xs')}</div>`).join('') +
        `</div><div class="panel"><div class="panel-head"><h2>personal.md（本机路径映射 · 仅本机）</h2>${badge('用户确认立即保存', 'success')}</div>` +
        MEM.personal.map((m) => `<div class="c4-bar" style="justify-content:space-between;padding:6px 0;box-shadow:inset 0 -1px var(--border-soft)"><div><strong class="mono">${esc(m.repo)}</strong><p class="meta mono">${esc(m.dir || '未克隆')}</p></div>${badge(m.status, m.conflict ? 'warn' : 'success', 'xs')}</div>`).join('') + `</div>`;
    } else if (v === 'roles') {
      const ws = curWs();
      inner = `<div class="panel"><div class="panel-head"><h2>${esc(ws.name)} · 成员 (${ws.members.length})</h2>${badge('最后一名管理员受保护', 'neutral')}</div>` +
        ws.members.map((m) => `<div class="c4-bar" style="justify-content:space-between;padding:6px 0;box-shadow:inset 0 -1px var(--border-soft)">` +
          `<div class="c4-bar">${av(m, 28)}<div><strong>${esc(PEOPLE[m].name)}</strong><p class="meta">${esc(PEOPLE[m].role)}</p></div></div>` +
          `<div class="c4-bar">${badge(teamRole(ws.id, m), teamRole(ws.id, m) === '管理员' ? 'accent' : 'neutral')}` +
          (isAdmin(ws.id) && m !== state.me ? `<button type="button" class="btn btn-secondary btn-xs" data-act="handover-demo" data-id="${m}">模拟离职交接预览</button>` : '') + `</div></div>`).join('') + `</div>`;
    } else if (v === 'gateway') {
      inner = `<div class="panel">${ADMIN_DATA.gateways.map((g) => `<div class="c4-bar" style="justify-content:space-between;padding:8px 0;box-shadow:inset 0 -1px var(--border-soft)"><div><strong>${esc(g.name)}</strong><p class="meta">${esc(g.provider)} · ${esc(g.quota)}</p></div><div class="c4-bar">${badge(g.roleScope, 'neutral', 'xs')}${badge(g.status, g.status === '正常' ? 'success' : 'warn')}</div></div>`).join('')}</div>`;
    } else if (v === 'skills') {
      inner = `<div class="panel">${ADMIN_DATA.skillsMcp.map((x) => `<div class="c4-bar" style="justify-content:space-between;padding:8px 0;box-shadow:inset 0 -1px var(--border-soft)"><div><strong>${esc(x.name)}</strong> ${badge(x.type, 'muted', 'xs')}<p class="meta">${esc(x.scan)}</p></div><div class="c4-bar">${badge(x.scope, 'neutral', 'xs')}${badge(x.status, x.status === '待审核' ? 'warn' : 'success')}</div></div>`).join('')}</div>`;
    } else if (v === 'audit') {
      inner = `<div class="panel">${ADMIN_DATA.audits.map((a) => `<div class="c4-bar" style="justify-content:space-between;padding:8px 0;box-shadow:inset 0 -1px var(--border-soft)"><div><strong>${esc(a.actor)} · ${esc(a.action)}</strong><p class="meta">${esc(a.target)}</p></div><div class="c4-bar">${badge(a.mask, 'success', 'xs')}<span class="meta">${esc(a.time)}</span></div></div>`).join('')}</div>`;
    } else if (v === 'diagnostics') {
      inner = `<div class="panel"><p style="font-size:var(--text-sm)">点击下方按钮将采集本机 ACP 版本、网关连通性、目录映射与脱敏后的错误堆栈，生成离线排障诊断 JSON。</p>` +
        `<div class="c4-bar"><button type="button" class="btn btn-primary btn-sm" data-act="export-diag">一键导出脱敏诊断包</button></div></div>`;
    } else {
      inner = `<div class="panel">${(WS_REPOS[state.ws] || []).map((r) => `<div class="c4-bar" style="justify-content:space-between;padding:6px 0;box-shadow:inset 0 -1px var(--border-soft)"><strong class="mono">${esc(r)}</strong>${badge('已纳入团队地图', 'success', 'xs')}</div>`).join('')}</div>`;
    }
    return `<div class="page-wrap"><div class="page-head"><div><h1>${esc(head[0])}</h1><p>${esc(head[1])}</p></div></div>${inner}</div>`;
  }

  function renderStage() {
    const stage = $('#stage');
    const peer = curPeer();
    const isFixed = !!peer || state.nav === 'chat';
    stage.classList.toggle('fixed', isFixed);
    if (peer) stage.innerHTML = viewPeer();
    else if (state.nav === 'chat') stage.innerHTML = viewChat();
    else if (state.nav === 'inbox') stage.innerHTML = viewInbox();
    else if (state.nav === 'board') stage.innerHTML = viewBoard();
    else if (state.nav === 'knowledge') stage.innerHTML = viewKnowledge();
    else if (state.nav === 'playbooks') stage.innerHTML = viewPlaybooks();
    else if (state.nav === 'admin') stage.innerHTML = viewAdmin();

    if (state.shouldScrollEnd) {
      state.shouldScrollEnd = false;
      const sc = $('#chatScroll');
      if (sc) sc.scrollTop = sc.scrollHeight;
    }
  }

  /* ═══ 右侧工作区（文件 / 变更 / 产物预览） ═══ */
  function renderRightDock() {
    const s = curSession();
    const hide = !state.railOpen || state.nav !== 'chat' || !!curPeer() || !s;
    $('#app').classList.toggle('no-rail', hide);
    document.documentElement.style.setProperty('--dock-w', state.railW + 'px');
    const rail = $('#rail');
    if (hide) { rail.innerHTML = ''; return; }

    const files = s.files || [];
    const arts = s.artifacts || [];
    let body = '';
    if (state.dockTab === 'files') {
      body = `<div class="c4-bar">${badge(baseName(s.mainDir), 'neutral', 'xs mono')}${s.extraDirs.map((d) => badge('+' + baseName(d), 'accent', 'xs mono')).join('')}</div>` +
        (files.length ? files.map((f) => `<button type="button" class="tree-row${state.preview && state.preview.active === f.n ? ' is-active' : ''}" data-act="open-file" data-file="${esc(f.n)}">${icon('file', 13)}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.n)}</span>${badge(f.st, f.st === 'A' ? 'success' : 'info', 'xs mono')}</button>`).join('') : `<p class="meta">暂无改动文件</p>`);
    } else if (state.dockTab === 'changes') {
      body = (files.length
        ? files.map((f) => `<button type="button" class="tree-row" data-act="open-file" data-file="${esc(f.n)}" data-diff="1">${icon('git', 13)}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.n)}</span><span class="meta mono">+${f.add} -${f.del}</span></button>`).join('')
        : `<div class="panel" style="padding:12px"><strong style="font-size:12.5px">工作区无未提交改动</strong><p class="meta">Agent 已提交的改动请在代码分支或提交记录查看，工作区只统计相对 HEAD 的实时变更。</p></div>`) +
        `<div class="meta" style="padding-top:8px">${icon('lock', 12)} 只读变更视图 · 提交推送由本机命令或审批触发</div>`;
    } else {
      body = !arts.length
        ? `<p class="meta">本轮会话暂无 Markdown / Mermaid / SVG 产物。Agent 生成报告或图表后将自动聚合在这里。</p>`
        : arts.map((a) => `<div class="art-card"><div class="c4-bar" style="justify-content:space-between"><strong>${esc(a.title)}</strong>` +
            `<button type="button" class="btn btn-ghost btn-xs" data-act="toggle-art-mode">${state.artMode === 'render' ? '看源码' : '排版预览'}</button></div>` +
            `<div class="art-render">${state.artMode === 'source' ? `<pre class="mono" style="margin:0;white-space:pre-wrap">${esc(a.body + (a.mermaid ? '\n\n```mermaid\n' + a.mermaid + '\n```' : ''))}</pre>` : `<p style="white-space:pre-wrap">${esc(a.body)}</p>${a.mermaid ? `<div style="margin-top:8px;padding:8px;border-radius:6px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--border)"><span class="meta">Mermaid 时序图已渲染预览：</span><pre class="mono" style="margin:4px 0 0;font-size:11px;color:var(--accent-text)">${esc(a.mermaid)}</pre></div>` : ''}`}</div></div>`).join('');
    }

    rail.innerHTML = `<button type="button" class="rail-resize" id="railResize" title="拖拽调整右栏宽度"></button>` +
      `<div class="dock-head"><div class="dock-tabs">` +
        `<button type="button" class="dock-tab${state.dockTab === 'files' ? ' is-active' : ''}" data-act="dock-tab" data-id="files">${icon('folder', 13)}文件</button>` +
        `<button type="button" class="dock-tab${state.dockTab === 'changes' ? ' is-active' : ''}" data-act="dock-tab" data-id="changes">${icon('git', 13)}变更${files.length ? `<span class="dock-badge">${files.length}</span>` : ''}</button>` +
        `<button type="button" class="dock-tab${state.dockTab === 'artifacts' ? ' is-active' : ''}" data-act="dock-tab" data-id="artifacts">${icon('artifact', 13)}产物${arts.length ? `<span class="dock-badge">${arts.length}</span>` : ''}</button>` +
      `</div><button type="button" class="icon-btn" data-act="toggle-rail" title="收起">${icon('x', 14)}</button></div>` +
      `<div class="dock-scroll">${body}</div>`;
    wireRailResize();
  }

  function wireRailResize() {
    const h = $('#railResize');
    if (!h) return;
    h.onpointerdown = (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = state.railW;
      h.classList.add('is-drag');
      const move = (ev) => {
        state.railW = Math.round(Math.min(460, Math.max(260, startW - (ev.clientX - startX))));
        document.documentElement.style.setProperty('--dock-w', state.railW + 'px');
      };
      const up = () => {
        h.classList.remove('is-drag');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
  }

  /* ═══ 浮层：命令面板 / 用户头像 Popover / 协同成员 Popover / Modal ═══ */
  function openUserPopover(anchor) {
    const pop = $('#userPopover');
    const r = anchor.getBoundingClientRect();
    pop.style.left = (r.right + 10) + 'px';
    pop.style.bottom = Math.max(12, window.innerHeight - r.bottom) + 'px';
    pop.style.top = 'auto';
    pop.hidden = false;
    pop.innerHTML =
      `<div class="c4-bar">${av(state.me, 32)}<div><strong>${esc(PEOPLE[state.me].name)}</strong><p class="meta">${esc(PEOPLE[state.me].role)}</p></div></div>` +
      `<div style="box-shadow:inset 0 1px 0 var(--border-soft);padding-top:8px"><span class="meta">外观主题</span>` +
        `<div class="seg" style="width:100%;margin-top:4px;display:grid;grid-template-columns:1fr 1fr"><button type="button" class="${state.theme === 'light' ? 'is-active' : ''}" data-act="set-theme" data-id="light">${icon('sun', 12)} 浅色</button><button type="button" class="${state.theme === 'dark' ? 'is-active' : ''}" data-act="set-theme" data-id="dark">${icon('moon', 12)} 深色</button></div></div>` +
      `<div style="box-shadow:inset 0 1px 0 var(--border-soft);padding-top:8px"><span class="meta">切换演示视角</span>` +
        [ADMIN, DEV, SOLO].map((id) => `<button type="button" class="menu-item" data-act="switch-me" data-id="${id}">${av(id, 18)}<span style="flex:1">${esc(PEOPLE[id].name)}</span>${state.me === id ? icon('check', 13) : ''}</button>`).join('') +
      `</div>`;
  }

  function openPalette() {
    const wrap = $('#palette');
    wrap.hidden = false;
    state.palQ = '';
    renderPalette();
    setTimeout(() => $('#palQ')?.focus(), 0);
  }
  function renderPalette() {
    const q = state.palQ.trim().toLowerCase();
    const hit = (s) => !q || String(s).toLowerCase().includes(q);
    const items = [
      ...mySessions().filter((s) => hit(s.title)).slice(0, 4).map((s) => ({ act: 'open-session', id: s.id, title: s.title, sub: '我的会话 · ' + s.mainDir })),
      ...state.knowledge.filter((k) => teamRole(k.ws, state.me) && hit(k.title)).slice(0, 4).map((k) => ({ act: 'goto-know', id: k.id, title: k.title, sub: '团队知识 · ' + k.version })),
      ...state.tasks.filter((t) => projectAccess(projById(t.proj)) && hit(t.title)).slice(0, 4).map((t) => ({ act: 'jump-board', id: t.id, title: t.title, sub: '任务 · ' + STATUS_TEXT[t.status] }))
    ];
    $('#palette').innerHTML = `<div class="palette" role="dialog" aria-modal="true">` +
      `<div class="palette-input">${icon('search', 16)}<input id="palQ" data-role="pal-q" value="${esc(state.palQ)}" placeholder="跨范围检索会话、知识、任务…"><span class="kbd">Esc</span></div>` +
      `<div class="palette-list">${items.length ? items.map((it) => `<button type="button" class="p-item" data-act="${it.act}" data-id="${esc(it.id)}" data-title="${esc(it.title)}"><div><strong>${esc(it.title)}</strong><p class="meta">${esc(it.sub)}</p></div></button>`).join('') : `<p class="meta" style="padding:12px">无匹配结果</p>`}</div></div>`;
  }

  function showModal(title, sub, bodyHtml, footHtml) {
    const dlg = $('#dlgModal');
    dlg.innerHTML = `<div class="dlg"><div class="dlg-head"><div><h2 id="dlgModalTitle">${esc(title)}</h2>${sub ? `<p class="dlg-sub">${esc(sub)}</p>` : ''}</div><button type="button" class="icon-btn" data-act="dlg-close" data-dlg="dlgModal" style="margin-left:auto">${icon('x', 15)}</button></div><div class="dlg-body">${bodyHtml}</div><div class="dlg-foot">${footHtml}</div></div>`;
    dlg.showModal();
  }

  /* ═══ 主渲染与事件委托 ═══ */
  function render() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.accent = state.accent;
    document.documentElement.dataset.density = state.density;
    document.documentElement.style.setProperty('--ui-zoom', String(state.zoom));
    renderRailBar();
    renderSecondarySidebar();
    renderTopbar();
    renderStage();
    renderRightDock();
  }

  function openPublishModal(s) {
    const targets = publishTargetsFor(s);
    if (!targets.length) { toast('当前没有可发布到的活跃 Project'); return; }
    const defProj = targets.find((p) => p.id === state.proj) || targets[0];
    const teamInfo = s.team
      ? `<div class="info-box">该会话已绑定团队上下文 <strong>${esc(wsById(s.team).name)}</strong>，仅可发布到同团队下的 Project。</div>`
      : `<div class="warn-box">该会话当前为<strong>「无团队」</strong>个人会话；发布后将显式绑定目标 Project 所属的 Workspace，从下一次主动发送起启用该团队的知识与本机记忆。</div>`;
    showModal(
      '发布到 Project…',
      `会话《${s.title}》仍只在本机执行，不会远程启动你的设备`,
      `${teamInfo}` +
      `<div class="fld"><label for="pubTargetProj">目标 Project</label>` +
        `<select id="pubTargetProj" class="c4-select" style="width:100%">` +
          targets.map((p) => `<option value="${p.id}"${p.id === defProj.id ? ' selected' : ''}>${esc(wsById(p.ws).name)} · ${esc(p.name)}</option>`).join('') +
        `</select></div>` +
      `<div class="fld"><span>共享可见档位（HC-239）</span>` +
        `<div class="choice-list">` +
          `<label class="choice-opt"><input type="radio" name="pubMode" value="full" checked><div><strong style="font-size:13px">完整定稿正文 + 工具摘要（只读）</strong><p class="meta">Project 成员可主动拉取定稿对话与工具摘要，仍不含未提交草稿。</p></div></label>` +
          `<label class="choice-opt"><input type="radio" name="pubMode" value="summary"><div><strong style="font-size:13px">仅共享状态与成果摘要</strong><p class="meta">不上传对话正文，队友仅可见会话进度、仓库与成果简报。</p></div></label>` +
        `</div></div>` +
      `<p class="meta">提示：发布后 Project 成员可见；已被他人同步到本地的内容，即使后续停止共享也无法从对方设备收回。</p>`,
      `<button type="button" class="btn btn-secondary btn-sm" data-act="dlg-close" data-dlg="dlgModal">取消</button>` +
      `<button type="button" class="btn btn-primary btn-sm" data-act="confirm-publish">确认发布到 Project</button>`
    );
  }

  function openStopShareModal(s) {
    const pj = projById(s.shareProject);
    showModal(
      '停止共享会话',
      `《${s.title}》将退出「${pj ? pj.name : 'Project'}」协作列表`,
      `<div class="warn-box">停止共享后：本会话将移回「个人」页签继续在本机使用，不再向远端上传新消息。<strong>已上传的历史内容在远端保留只读并标记「已停止同步」</strong>；原有的团队上下文绑定保持不变。</div>`,
      `<button type="button" class="btn btn-secondary btn-sm" data-act="dlg-close" data-dlg="dlgModal">保留共享</button>` +
      `<button type="button" class="btn btn-danger btn-sm" data-act="confirm-stop-share">确认停止共享</button>`
    );
  }

  function sendMessage(text) {
    const msg = String(text || '').trim();
    if (!msg) return;
    let s = curSession();
    if (!s) {
      const id = 's-' + Date.now();
      const pubProj = state.newPubProj ? projById(state.newPubProj) : null;
      s = {
        id, owner: state.me,
        team: pubProj ? pubProj.ws : (state.newTeam || null),
        shareProject: pubProj ? pubProj.id : null,
        shareMode: pubProj ? 'full' : undefined,
        title: msg.slice(0, 18) + (msg.length > 18 ? '…' : ''),
        time: '刚刚', mainDir: state.newDir, extraDirs: [], running: false, unread: false,
        files: [], artifacts: [], msgs: []
      };
      state.sessions.unshift(s);
      state.session = id;
      state.workTab = pubProj ? 'team' : 'personal';
      state.newPubProj = null;
      state.drafts.__welcome__ = '';
      toast(pubProj ? `已创建协作会话并发布到「${pubProj.name}」` : '已自动创建个人本机会话并发送');
    } else if (state.busySim) {
      state.queued.push({ id: 'q-' + Date.now(), text: msg });
      state.drafts[s.id] = '';
      render();
      toast('Agent 正在输出，消息已进入排队托盘');
      return;
    } else {
      state.drafts[s.id] = '';
    }
    s.msgs.push({ w: state.me, time: '刚刚', text: msg });
    s.msgs.push({
      w: 'agent', time: '刚刚', model: s.team ? 'Claude Sonnet 4.5 (企业网关)' : 'Local / Default',
      blocks: [{ t: 'p', text: `已收到指令并在本机目录 \`${s.mainDir}\` 完成分析。${s.team ? '本轮已自动应用团队规约与本机记忆。' : '当前为无团队纯本机会话。'}` }]
    });
    s.time = '刚刚';
    state.atq = null;
    state.shouldScrollEnd = true;
    render();
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#userPopover, [data-act="user-pop"]')) $('#userPopover').hidden = true;
    if (!e.target.closest('#popover, [data-act="member-peek"]')) $('#popover').hidden = true;
    if (!e.target.closest('#menu, [data-act="ws-menu"]')) $('#menu').hidden = true;

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const id = btn.getAttribute('data-id');

    switch (act) {
      case 'rail-nav': {
        const nav = btn.getAttribute('data-nav');
        state.nav = nav;
        state.cross = null;
        state.drawerOpen = false;
        render();
        break;
      }
      case 'admin-nav': state.adminView = id; render(); break;
      case 'admin-jump': state.nav = 'admin'; state.adminView = id; render(); break;
      case 'side-toggle': state.sideOpen = !state.sideOpen; render(); break;
      case 'drawer': state.drawerOpen = !state.drawerOpen; $('#sidebar').classList.toggle('is-open', state.drawerOpen); $('#scrim').hidden = !state.drawerOpen; break;
      case 'drawer-close': state.drawerOpen = false; $('#sidebar').classList.remove('is-open'); $('#scrim').hidden = true; break;
      case 'back-home': state.cross = null; state.nav = (state.returnTo && state.returnTo.nav) || 'chat'; state.returnTo = null; render(); break;
      case 'work-tab': {
        state.workTab = id === 'team' ? 'team' : 'personal';
        renderSecondarySidebar();
        break;
      }
      case 'toggle-dir': { const d = btn.getAttribute('data-dir'); state.dirOpen[d] = state.dirOpen[d] === false; renderSecondarySidebar(); break; }
      case 'toggle-proj': state.collabOpen[id] = !((id in state.collabOpen) ? state.collabOpen[id] : id === state.proj); renderSecondarySidebar(); break;
      case 'open-session': {
        state.nav = 'chat'; state.cross = null; state.session = id;
        const os = curSession();
        if (os) {
          os.unread = false;
          state.workTab = os.shareProject ? 'team' : 'personal';
          if (os.shareProject) state.proj = os.shareProject;
        }
        render(); break;
      }
      case 'open-peer': state.nav = 'chat'; state.workTab = 'team'; state.cross = { owner: btn.getAttribute('data-owner'), id }; render(); break;
      case 'open-proj-info': {
        const pj = projById(id);
        if (!pj) break;
        showModal(`Project 资料 · ${pj.name}`, `${wsById(pj.ws).name} · 仓库 ${pj.repo || '未关联'}`,
          `<p style="font-size:var(--text-sm)">${esc(pj.desc || '暂无说明')}</p>` +
          `<div class="panel" style="padding:10px;background:var(--surface-2)"><strong style="font-size:12.5px">成员范围（${pj.members.length} 人）</strong>` +
            `<div class="c4-bar" style="margin-top:6px">${pj.members.map((m) => `<span class="hui-badge">${av(m, 16)}${esc(PEOPLE[m].name)}</span>`).join('')}</div></div>`,
          `<button type="button" class="btn btn-primary btn-sm" data-act="dlg-close" data-dlg="dlgModal">关闭</button>`);
        break;
      }
      case 'welcome-dir': {
        const dirs = ['~/work/pay/checkout-split', '~/work/pay/bill-export', '~/playground/local-demo'];
        const cur = dirs.indexOf(state.newDir);
        state.newDir = dirs[(cur + 1) % dirs.length];
        renderStage();
        toast('已切换起步目录：' + state.newDir);
        break;
      }
      case 'jump-prompt': {
        const pIdx = Number(btn.getAttribute('data-idx') || 0);
        state.activePromptIdx = pIdx;
        const target = $('#chatScroll')?.querySelector(`[data-prompt-idx="${pIdx}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        renderStage();
        break;
      }
      case 'new-welcome': state.nav = 'chat'; state.cross = null; state.workTab = 'personal'; state.newPubProj = null; state.session = null; render(); break;
      case 'new-proj-welcome': {
        state.nav = 'chat'; state.cross = null; state.workTab = 'team';
        state.newTeam = state.ws; state.newPubProj = state.proj || wsProjects()[0]?.id || null;
        state.session = null; render(); break;
      }
      case 'toggle-rail': state.railOpen = !state.railOpen; render(); break;
      case 'dock-tab': state.dockTab = id; renderRightDock(); break;
      case 'toggle-art-mode': state.artMode = state.artMode === 'render' ? 'source' : 'render'; renderRightDock(); break;
      case 'open-file': {
        const f = btn.getAttribute('data-file');
        state.ptab = btn.getAttribute('data-diff') === '1' ? 'diff' : 'code';
        if (!state.preview) state.preview = { tabs: [f], active: f };
        else { if (!state.preview.tabs.includes(f)) state.preview.tabs.push(f); state.preview.active = f; }
        renderStage(); renderRightDock(); break;
      }
      case 'close-filepane': state.preview = null; renderStage(); break;
      case 'toggle-ptab': state.ptab = state.ptab === 'diff' ? 'code' : 'diff'; renderStage(); break;
      case 'toggle-tool': { const tid = btn.getAttribute('data-tid'); state.openTools[tid] = !state.openTools[tid]; renderStage(); break; }
      case 'toggle-ctx': state.ctxOpen = !state.ctxOpen; renderStage(); break;
      case 'toggle-busy-sim': state.busySim = !state.busySim; render(); toast(state.busySim ? '已开启模拟运行：输入并发送将进入排队托盘' : '已停止模拟运行'); break;
      case 'send-msg': sendMessage($('#composer')?.value); break;
      case 'queue-steer': {
        const q = state.queued.find((x) => x.id === id);
        state.queued = state.queued.filter((x) => x.id !== id);
        if (q) {
          const s = curSession();
          if (s) {
            s.msgs.push({ w: state.me, time: '引导插队', text: q.text });
            s.msgs.push({ w: 'agent', time: '刚刚', model: 'Claude Sonnet 4.5', blocks: [{ t: 'p', text: '已中断上一条长生成并立即响应你的引导消息：已核对 `job/compensate.ts`，确认同样校验了 `retryAfterMs`。' }] });
          }
          state.busySim = false;
          state.shouldScrollEnd = true;
          render();
          toast('已通过「引导」立即发送');
        }
        break;
      }
      case 'queue-del': state.queued = state.queued.filter((x) => x.id !== id); renderStage(); break;
      case 'queue-resume': state.queueHeld = false; renderStage(); break;
      case 'approve': {
        state.approvalDecisions[id] = btn.getAttribute('data-dec');
        render();
        toast(state.approvalDecisions[id] === 'denied' ? '已拒绝本次外部写入' : '已批准执行 Git Push');
        break;
      }
      case 'copy-diag': toast('已复制脱敏诊断 JSON（已自动屏蔽 Token 与个人正文）'); break;
      case 'export-diag': toast('已导出脱敏排障诊断包 harness-diag-masked.json'); break;
      case 'open-at': state.atq = state.atq === null ? '' : null; renderStage(); break;
      case 'pick-at-know': {
        const k = state.knowledge.find((x) => x.id === id);
        const ta = $('#composer');
        if (k && ta) { ta.value = ta.value.replace(/@[^\s]*$/, '') + `@《${k.title}》${k.version} `; state.drafts[curSession()?.id || '__welcome__'] = ta.value; }
        state.atq = null; renderStage(); $('#composer')?.focus(); break;
      }
      case 'pick-at-person': {
        state.atq = null;
        $('#disTo').innerHTML = (curProj().members || WORKSPACES[0].members).filter((m) => m !== state.me).map((m) => `<option value="${m}"${m === id ? ' selected' : ''}>${esc(PEOPLE[m].name)}</option>`).join('');
        $('#dlgDispatch').showModal();
        break;
      }
      case 'share-to-proj': {
        const s = curSession();
        if (s) openPublishModal(s);
        break;
      }
      case 'confirm-publish': {
        const s = curSession();
        const pid = $('#pubTargetProj')?.value;
        const pj = projById(pid);
        const mode = document.querySelector('input[name="pubMode"]:checked')?.value || 'full';
        if (s && pj) {
          const hadTeam = !!s.team;
          s.shareProject = pj.id;
          s.shareMode = mode;
          if (!s.team) s.team = pj.ws;
          state.ws = pj.ws;
          state.proj = pj.id;
          state.workTab = 'team';
          state.collabOpen[pj.id] = true;
          state.landingId = s.id;
          $('#dlgModal')?.close();
          render();
          setTimeout(() => { state.landingId = null; }, 950);
          toast(hadTeam
            ? `已发布到「${pj.name}」(${mode === 'summary' ? '仅共享摘要' : '只读正文'})`
            : `已发布到「${pj.name}」并显式绑定团队「${wsById(pj.ws).name}」`);
        }
        break;
      }
      case 'stop-share': {
        const s = curSession();
        if (s && s.shareProject) openStopShareModal(s);
        break;
      }
      case 'confirm-stop-share': {
        const s = curSession();
        if (s) {
          s.shareProject = null;
          delete s.shareMode;
          state.workTab = 'personal';
          state.landingId = s.id;
          $('#dlgModal')?.close();
          render();
          setTimeout(() => { state.landingId = null; }, 950);
          toast('已停止共享，会话已移回「个人」页签（原团队绑定保持不变）');
        }
        break;
      }
      case 'sync-peer': { const p = curPeer(); if (p) { state.synced[snapKey(p)] = true; render(); toast('已拉取定稿正文（只读）'); } break; }
      case 'add-peer-note': {
        const p = curPeer(), inp = $('#peerNoteInput');
        if (p && inp && inp.value.trim()) { p.notes.push({ who: state.me, time: '刚刚', text: inp.value.trim() }); renderStage(); toast('已发送异步批注（进入对方 Inbox）'); }
        break;
      }
      case 'cite-peer': {
        const p = curPeer();
        if (p) {
          const ns = { id: 's-cite-' + Date.now(), owner: state.me, team: state.ws, shareProject: null, title: '引用 ' + PEOPLE[p.owner].name + ' · ' + p.title, time: '刚刚', mainDir: '~/work/pay/checkout-split', extraDirs: [], running: false, unread: false, files: [], artifacts: [], msgs: [{ w: 'reference', from: p.owner, raw: p.title, said: p.brief, local: '~/work/pay/checkout-split' }] };
          state.sessions.unshift(ns); state.cross = null; state.session = ns.id; state.workTab = 'personal'; state.nav = 'chat'; render(); toast('已引用到我的个人本机会话');
        }
        break;
      }
      case 'dispatch-from-peer': {
        $('#disTo').innerHTML = curWs().members.filter((m) => m !== state.me).map((m) => `<option value="${m}">${esc(PEOPLE[m].name)}</option>`).join('');
        $('#dlgDispatch').showModal();
        break;
      }
      case 'open-dirs': {
        const s = curSession();
        if (!s) break;
        showModal('会话工作目录（主目录 + 附加目录 · HC-242）', '一个本机 Agent 同时访问多个关联仓库，按系统地图推荐',
          `<p><strong>主目录：</strong><span class="mono">${esc(s.mainDir)}</span></p><p><strong>已附加目录：</strong>${s.extraDirs.length ? s.extraDirs.map((d) => `<span class="hui-badge mono">${esc(d)}</span>`).join(' ') : '无'}</p>` +
          `<div class="panel" style="padding:10px;background:var(--surface-2)"><span class="meta">系统地图建议附加：</span><div class="c4-bar" style="margin-top:4px"><button type="button" class="btn btn-soft btn-xs" data-act="add-extra-dir" data-dir="~/work/pay/bill-export">+ 加入 ~/work/pay/bill-export</button></div></div>`,
          `<button type="button" class="btn btn-primary btn-sm" data-act="dlg-close" data-dlg="dlgModal">完成</button>`);
        break;
      }
      case 'add-extra-dir': {
        const s = curSession(), d = btn.getAttribute('data-dir');
        if (s && d && !s.extraDirs.includes(d)) { s.extraDirs.push(d); $('#dlgModal').close(); render(); toast('已加入附加目录 ' + d); }
        break;
      }
      case 'open-draft': {
        showModal('沉淀为团队知识（HC-241）', '本机 Agent 已对照已有知识生成差异草稿，提交后进入管理员审核',
          `<div class="fld"><label>标题</label><input type="text" id="draftTitle" value="回调幂等经验（补充补偿窗口边界）"></div>` +
          `<div class="diff"><div class="diff-row is-add"><span>+</span><span>job/compensate.ts 必须在获取租约锁后先走幂等闸门</span></div></div>` +
          `<div class="c4-bar"><select class="c4-select" id="draftLevel"><option value="exp">经验（标题目录 + 按需读取）</option><option value="rule">建议升为规约（范围匹配直带）</option></select></div>`,
          `<button type="button" class="btn btn-secondary btn-sm" data-act="dlg-close" data-dlg="dlgModal">取消</button><button type="button" class="btn btn-primary btn-sm" data-act="submit-draft">提交审核</button>`);
        break;
      }
      case 'submit-draft': {
        const title = $('#draftTitle')?.value?.trim() || '新沉淀知识';
        state.proposals.unshift({ id: 'pr-' + Date.now(), ws: state.ws, kind: 'knowledge', level: $('#draftLevel')?.value || 'exp', applies: 'pay/checkout-split', title, author: state.me, time: '刚刚', status: 'pending', source: '会话主动沉淀', diff: [{ t: 'add', x: 'job/compensate.ts 必须在获取租约锁后先走幂等闸门' }] });
        $('#dlgModal').close(); render(); toast('已提交到 Inbox 待管理员审核'); break;
      }
      case 'apply-playbook': {
        const pb = PLAYBOOKS.find((x) => x.id === id);
        if (pb) { state.nav = 'chat'; state.cross = null; state.session = null; state.newDir = pb.dirs[0]; state.drafts.__welcome__ = pb.prompt; render(); toast(`已套用「${pb.title}」，可直接发送启动`); }
        break;
      }
      case 'inbox-tab': state.inboxTab = id; state.inboxSel = null; renderStage(); break;
      case 'inbox-type': state.inboxType = id; state.inboxSel = null; renderStage(); break;
      case 'inbox-sel': state.inboxSel = id; renderStage(); break;
      case 'claim-task': { const t = state.tasks.find((x) => x.id === id); if (t) { t.status = 'claimed'; render(); toast('已接受任务，进入「待开始」列'); } break; }
      case 'decline-task': { const t = state.tasks.find((x) => x.id === id); if (t) { t.status = 'declined'; render(); toast('已拒绝任务'); } break; }
      case 'start-task': {
        state.taskSel = null;
        const t = state.tasks.find((x) => x.id === id);
        if (t) {
          t.status = 'running'; t.live = true;
          const ns = { id: 's-task-' + Date.now(), owner: state.me, team: state.ws, shareProject: t.proj, title: t.title, time: '刚刚', mainDir: '~/work/pay/checkout-split', extraDirs: [], running: true, unread: false, files: [], artifacts: [], msgs: [{ w: state.me, time: '刚刚', text: `开始处理任务《${t.title}》：${t.desc}` }] };
          state.sessions.unshift(ns); state.session = ns.id; state.workTab = 'team'; state.proj = t.proj; state.nav = 'chat'; render(); toast('已在本机新建任务会话并开始执行');
        }
        break;
      }
      case 'prop-approve': {
        const p = state.proposals.find((x) => x.id === id);
        if (p) {
          p.status = 'published';
          if (p.kind === 'knowledge') {
            state.knowledge.unshift({ id: 'k-' + Date.now(), ws: p.ws, level: p.level || 'exp', applies: p.applies || '全团队', version: 'v2.2', updated: '刚刚', author: p.author, title: p.title, sum: '管理员审核合并发布', body: p.diff.map((d) => d.x).join('\n'), hits: 1, useful: 1, traces: [] });
          }
          render(); toast('已批准发布，全团队成员知识目录已刷新');
        }
        break;
      }
      case 'prop-reject': { const p = state.proposals.find((x) => x.id === id); if (p) { p.status = 'rejected'; render(); toast('已退回该提议'); } break; }
      case 'req-approve': { const r = state.requests.find((x) => x.id === id); if (r) { r.status = 'approved'; render(); toast('已同意申请'); } break; }
      case 'req-reject': { const r = state.requests.find((x) => x.id === id); if (r) { r.status = 'rejected'; render(); toast('已拒绝申请'); } break; }
      case 'board-scope': state.boardScope = id; renderStage(); break;
      case 'board-view': state.boardView = id; renderStage(); break;
      case 'task-open': state.taskSel = id; renderStage(); break;
      case 'task-close': state.taskSel = null; renderStage(); break;
      case 'jump-board': state.nav = 'board'; state.taskSel = id; $('#palette').hidden = true; render(); break;
      case 'k-scope': state.kscope = id; renderStage(); break;
      case 'k-sel': state.kSel = id; renderStage(); break;
      case 'pick-map': state.selectedMapRepo = state.selectedMapRepo === id ? null : id; renderStage(); break;
      case 'mark-useful': { const k = state.knowledge.find((x) => x.id === id); if (k) { k.useful++; renderStage(); toast('已记录「有用」反馈'); } break; }
      case 'cite-k': {
        const k = state.knowledge.find((x) => x.id === id);
        if (k) { state.nav = 'chat'; state.drafts[curSession()?.id || '__welcome__'] = `@《${k.title}》${k.version} `; render(); toast('已插入引用到会话输入框'); }
        break;
      }
      case 'goto-know': {
        const title = btn.getAttribute('data-title');
        const hit = state.knowledge.find((k) => k.id === id || k.title === title);
        state.nav = 'knowledge'; state.kscope = 'all'; if (hit) state.kSel = hit.id; $('#palette').hidden = true; render(); break;
      }
      case 'new-project': {
        $('#projName').value = ''; $('#projDesc').value = ''; $('#projRepo').value = '';
        $('#projMemberList').innerHTML = curWs().members.map((m) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" value="${m}" checked ${m === state.me ? 'disabled' : ''}>${esc(PEOPLE[m].name)}</label>`).join('');
        $('#dlgProject').showModal(); break;
      }
      case 'new-task': {
        $('#disTo').innerHTML = curWs().members.filter((m) => m !== state.me).map((m) => `<option value="${m}">${esc(PEOPLE[m].name)}</option>`).join('');
        $('#dlgDispatch').showModal(); break;
      }
      case 'ws-menu': {
        const m = $('#menu'), r = btn.getBoundingClientRect();
        m.style.left = r.left + 'px'; m.style.top = (r.bottom + 4) + 'px'; m.hidden = false;
        m.innerHTML = WORKSPACES.filter((w) => teamRole(w.id, state.me)).map((w) => `<button type="button" class="menu-item" data-act="pick-ws" data-id="${w.id}">${wsDot(w.id)}<span>${esc(w.name)}</span>${w.id === state.ws ? icon('check', 13) : ''}</button>`).join('');
        break;
      }
      case 'pick-ws': { state.ws = id; state.proj = wsProjects()[0]?.id || null; $('#menu').hidden = true; render(); break; }
      case 'user-pop': { const p = $('#userPopover'); if (p.hidden) openUserPopover(btn); else p.hidden = true; break; }
      case 'member-peek': {
        const p = $('#popover'), r = btn.getBoundingClientRect();
        p.style.right = Math.max(12, window.innerWidth - r.right) + 'px'; p.style.left = 'auto'; p.style.top = (r.bottom + 6) + 'px'; p.hidden = false;
        const peers = peersOf(curProj().id);
        p.innerHTML = `<strong style="font-size:12.5px">队友共享会话（主动同步 · 只读）</strong>` +
          (peers.length ? peers.map(peerRow).join('') : `<p class="meta">暂无队友会话</p>`);
        break;
      }
      case 'switch-me': {
        state.me = id; $('#userPopover').hidden = true;
        if (id === SOLO) { state.session = 's-solo-1'; state.ws = null; state.workTab = 'personal'; }
        else { state.ws = 'ws-base'; const first = mySessions()[0]; state.session = first?.id || null; state.workTab = first?.shareProject ? 'team' : 'personal'; }
        state.cross = null; render(); toast('已切换演示视角：' + PEOPLE[id].name); break;
      }
      case 'set-theme': state.theme = id; render(); if (!$('#userPopover').hidden) openUserPopover($('.rail-avatar-btn')); break;
      case 'toggle-theme': state.theme = state.theme === 'dark' ? 'light' : 'dark'; render(); break;
      case 'set-accent': state.accent = id; render(); break;
      case 'set-zoom': state.zoom = Number(id); render(); break;
      case 'palette': openPalette(); break;
      case 'handover-demo': toast(`已触发 ${PEOPLE[id].name} 离职交接预览：未完结 Task 与仓库将事务回滚校验后转交接手人`); break;
      case 'dlg-close': $('#' + btn.getAttribute('data-dlg'))?.close(); break;
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    const role = e.target.getAttribute('data-role');
    if (role === 'composer') {
      const k = curSession()?.id || '__welcome__';
      state.drafts[k] = e.target.value;
      const m = e.target.value.match(/@([^\s@]*)$/);
      if (m && (curSession()?.team || state.newTeam)) {
        state.atq = m[1];
        renderStage();
        const ta = $('#composer');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      } else if (state.atq !== null && !m) {
        state.atq = null; renderStage();
      }
    } else if (role === 'pal-q') {
      state.palQ = e.target.value;
      renderPalette();
      const inp = $('#palQ');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  });

  document.addEventListener('change', (e) => {
    const role = e.target.getAttribute('data-role');
    if (role === 'welcome-team') { state.newTeam = e.target.value || null; renderStage(); }
    if (role === 'board-proj') { state.boardProj = e.target.value; renderStage(); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); state.sideOpen = !state.sideOpen; render(); }
    else if (e.key === 'Escape') {
      if (!$('#palette').hidden) $('#palette').hidden = true;
      else if (state.atq !== null) { state.atq = null; renderStage(); }
      else if (state.taskSel) { state.taskSel = null; renderStage(); }
    } else if (e.target.id === 'composer' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(e.target.value);
    }
  });

  $('#formProject')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#projName').value.trim();
    if (!name) return toast('请输入项目名称');
    const np = { id: 'p-' + Date.now(), ws: state.ws, name, desc: $('#projDesc').value.trim(), repo: $('#projRepo').value.trim(), created: '刚刚', lead: state.me, members: [state.me, DEV] };
    state.projects.push(np); state.proj = np.id; $('#dlgProject').close(); render(); toast('已创建 Project：' + name);
  });

  $('#formDispatch')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#disTitle').value.trim();
    if (!title) return toast('请输入任务标题');
    state.tasks.unshift({ id: 't-' + Date.now(), proj: state.proj || 'p-checkout', title, desc: $('#disDesc').value.trim() || '由对话派发', from: state.me, to: $('#disTo').value, status: 'open', prio: 'high', time: '刚刚', src: 'session', deliverable: '等待接手' });
    $('#dlgDispatch').close(); render(); toast('已派发任务');
  });

  render();
})();
