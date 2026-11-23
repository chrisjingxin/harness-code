(function () {
  'use strict';
  var LAYOUT_MODE = 'B';

  /* ═══════════ 人员 ═══════════ */
  var AV = 'assets/avatars/';
  var PEOPLE = {
    zhangjingxin: { name: '张景新', role: '后端开发', lead: true,  avatar: 'zhangjingxin.jpg' },
    shenbeichen:  { name: '沈北辰', role: '前端开发', lead: false, avatar: 'shenbeichen.jpg' },
    wangdalin:    { name: '王大林', role: '后端开发', lead: false, avatar: 'wangdalin.jpg' },
    mingfangpeng: { name: '明方鹏', role: '后端开发', lead: false, avatar: 'mingfangpeng.jpg' },
    yangkang:     { name: '杨康',   role: '后端开发', lead: false, avatar: 'yangkang.jpg' },
    fengxueming:  { name: '冯学茗', role: '前端开发', lead: false, avatar: 'fengxueming.jpg' }
  };
  var ADMIN = 'zhangjingxin', DEV = 'shenbeichen', SOLO = 'solo';
  var ME = ADMIN;
  PEOPLE[SOLO] = { name: '本机账号', role: '未加入团队' };

  /* ═══════════ 数据 ═══════════ */
  var state = {
    theme: 'light',
    accent: 'violet',
    density: 'standard',
    zoom: 1,
    rail: typeof window !== 'undefined' ? window.innerWidth > 1040 : true,
    railW: 300,
    dockTab: 'files',
    gitSub: 'changes',      /* 'changes' | 'history' */
    gitView: 'auto',        /* 'auto' | 'tree' | 'list' */
    gitFilterSt: 'all',     /* 'all' | 'M' | 'A' | 'U' */
    gitQ: '',
    gitDirOpen: {},
    gitLogScope: 'all',     /* 'all' | 'ahead' */
    gitLogQ: '',
    gitLogLimit: 8,
    gitStress: false,
    treeOpen: {},
    gitSel: {},
    openCommit: null,
    openCommitAll: {},
    pvMax: false,
    side: true,
    drawer: false,
    space: 'personal',      /* 'personal' | 'team' */
    sidePane: 'sessions',   /* 方案A用：'sessions' | 'inbox' | 'board' | 'tsessions' | 'knowledge' */
    teamPane: 'board',
    boardProj: 'all',
    boardScope: 'mine',     /* 默认我的：'mine' | 'all'（团队总览） */
    boardView: 'status',    /* 'status' | 'member' */
    boardOnlyIssues: false, /* 团队总览：仅看异常/停滞 */
    taskSel: null,
    returnTo: null,
    lastTeamView: 'board',
    ctxOpen: false,
    approvalBusy: {},
    handshake: null,
    selectedMapRepo: null,
    prevView: null,
    prevCross: null,
    prevInboxN: null,
    inboxTab: 'todo',       /* 'todo' | 'sent' */
    inboxType: 'all',
    inboxSel: null,
    dispatchSrc: null,
    requests: [
      { id: 'rq1', kind: 'join', ws: 'ws-risk', from: 'wangdalin', time: '20 分钟前', status: 'pending', note: '需要参与风控规则联调，申请以开发者身份加入「风控联调虚拟专项组」。' },
      { id: 'rq2', kind: 'role', role: '管理员', ws: 'ws-base', from: 'wangdalin', time: '昨天 17:30', status: 'pending', note: '负责对账单导出方向的知识沉淀，申请管理员权限以便审核相关提议。' },
      { id: 'rq3', kind: 'role', role: '管理员', ws: 'ws-base', from: 'shenbeichen', time: '3 天前', status: 'rejected', note: '希望能直接维护前端规约。', reason: '规约先走提议审核，暂不新增管理员。' }
    ],
    sideFloat: false,       /* 收起面板时图标点开的浮层面板 */
    sessFilter: 'all',      /* 'all' | workspaceId | 'none' */
    dirOpen: {},            /* 会话面板目录分组折叠 */
    collabOpen: {},         /* 协作面板 Project 折叠 */
    memberOpen: {},         /* 协作面板成员分组折叠 */
    preview: null,        /* { tabs: ['src/...'], active: 'src/...' } */
    ptab: 'code',
    kSel: null,
    kEdit: false,
    projEdit: false,
    ws: 'ws-base',
    proj: 'p-checkout',
    view: 'chat',
    session: 's1',
    cross: null,           /* {owner, id} */
    synced: {},            /* 'owner:id' -> true */
    task: 't0',
    taskFilter: 'assigned',
    kscope: 'all',
    proposals: [],
    propSel: null,
    propMode: 'supplement',
    memTab: 'team',
    newDirs: [],
    pop: { owner: 'all', filter: 'all', q: '' },
    palQ: '',
    palIdx: 0,
    atq: null,
    atIdx: 0,
    menuIdx: 0,
    drafts: {},
    approvalDecisions: {},
    plansConfirmed: {},
    copiedKey: null,
    openTools: {},
    activePromptIdx: 0,
    targetPromptIdx: null,
    shouldScrollEnd: false,
    focusKey: null,
    startTaskId: null,
    dispatchOwner: null,
    projects: [
      { id: 'p-checkout', ws: 'ws-base', name: '结账台拆分支付重构',
        desc: '拆单支付核心链路改造，涵盖状态机流转、幂等退款与灰度开关控制。',
        repo: 'pay/checkout-split', created: '2025-09-18',
        members: ['zhangjingxin','shenbeichen','wangdalin','mingfangpeng','yangkang','fengxueming'] },
      { id: 'p-bill', ws: 'ws-base', name: '对账单异步导出优化',
        desc: '优化大账单异步分片流式导出与游标断点续传，统一金额整数分规约。',
        repo: 'pay/bill-export', created: '2025-10-27',
        members: ['zhangjingxin','shenbeichen','wangdalin'] },
      { id: 'p-idem', ws: 'ws-base', name: '幂等键服务加固',
        desc: '加固分布式退款幂等键校验与 24 小时 TTL 过期兜底机制。',
        repo: 'pay/idempotency', created: '2025-11-05',
        members: ['zhangjingxin','wangdalin','mingfangpeng','yangkang'] },
      { id: 'p-risk', ws: 'ws-risk', name: '风控联调沙箱',
        desc: '联调风控沙箱回归规则验证，隔离线上主链路流量。',
        repo: 'risk/sandbox', created: '2025-11-14',
        members: ['zhangjingxin','mingfangpeng','fengxueming'] }
    ],
    sessions: [
      { id: 's1', proj: 'p-checkout', title: '支付状态机回调时序核对', local: true, running: true, dir: '~/work/harness/checkout-split', time: '12 分钟前', unread: false,
        files: [{ n: 'src/payment/state-machine.ts', t: '刚刚', st: 'M' }, { n: 'src/payment/callback/refund.ts', t: '6 分钟前', st: 'M' }, { n: 'docs/adr/checkout-split.md', t: '09:41', st: 'A' }],
        msgs: [
          { w: 'sys-divider', label: '今天 10:12 · 本机工作区 ~/work/harness/checkout-split' },
          { w: ME, time: '10:12',
            text: '先把拆分后的回调时序过一遍，重点看 `refund` 分支会不会在 partial 状态下提前触发。规范见 @《分布式幂等键设计规范》v2.1。',
            ctx: [{ t: 'state-machine.ts · L1-48', file: 'src/payment/state-machine.ts' }, { t: 'checkout-split.md', file: 'docs/adr/checkout-split.md' }] },
          { w: 'thinking', label: '思考过程', dur: '3.8s',
            body: ['回调可能早于订单落库，先确认状态机是否允许 partial 直接触发退款。', '再看补偿任务是否与回调用同一把幂等键。'] },
          { w: 'workgroup', title: '已完成 4 步检查（含 1 项初始失败）', dur: '2.0s',
            summary: '读取 state-machine.ts、搜索 refund(、定位幂等回归失败用例并复测',
            rows: [
              { ic: 'eye', verb: 'read_file', target: 'src/payment/state-machine.ts', badge: '42 行', tone: 'ok', file: 'src/payment/state-machine.ts',
                out: 'PAID -> [REFUNDING, PARTIAL_REFUNDED]\nPARTIAL_REFUNDED -> [REFUNDING]' },
              { ic: 'search', verb: 'grep', target: 'refund(', badge: '命中 2 处', tone: 'ok', file: 'src/payment/callback/refund.ts',
                out: 'callback/refund.ts:44  refundGateway.confirm(payload)\njob/compensate.ts:88   refundGateway.retry(orderId)' },
              { ic: 'terminal', verb: 'vitest', target: 'src/payment/__tests__/refund-idempotency.test.ts', badge: '1 个失败 · 0.6s', tone: 'err',
                out: 'FAIL src/payment/__tests__/refund-idempotency.test.ts\n  × 补偿任务重复回调仅触发一次退款 (expected 1 call, received 2)' },
              { ic: 'terminal', verb: 'vitest', target: 'src/payment/__tests__/state-machine.test.ts', badge: 'exit 0 · 0.8s', tone: 'ok',
                out: '✓ 12 passed (12)\n  state-machine.test.ts  812ms' }
            ] },
          { w: 'approval', id: 'a1', kind: '文件读取审批', state: 'resolved',
            resolvedText: '已由你允许一次 · docs/adr/checkout-split.md',
            code: 'read_file docs/adr/checkout-split.md',
            reason: '只读访问项目 ADR，不涉及写入。' },
          { w: 'agent', model: 'claude-sonnet-4', time: '10:13', blocks: [
              { t: 'p', text: '状态机里 `PAID → REFUNDING` 只有一条边，但回调处理里有两处会调用 `refund()`；补偿任务那条路径没落幂等键。' },
              { t: 'h', text: '结论' },
              { t: 'ol', items: ['`callback/refund.ts` 直接走渠道退款，未做键校验', '`job/compensate.ts` 重试时同样未落键，重复回调会二次退款'] },
              { t: 'code', lang: 'ts', code: '// callback/refund.ts — 统一收口幂等闸门\nexport async function onRefundCallback(p: RefundPayload) {\n  const key = `refund:${p.orderId}:${p.refundNo}`;\n  return idempotent(key, () => refundGateway.confirm(p));\n}' }
            ] },
          { w: ME, time: '10:14',
            text: '顺便把补偿任务入口一起收口，并补一份不混提交的改法计划。' },
          { w: 'subagent', name: 'Codebase Researcher', model: 'claude-sonnet-4', state: 'done', statusText: '已完成 · 6.4s',
            meta: '分支 feat/checkout-split · 目录 ~/work/harness/checkout-split',
            goal: '检索幂等键在回调与补偿两条链路上的落点，找出不一致处。',
            rows: [
              { ic: 'eye', verb: 'read_file', target: 'src/idempotency/guard.ts', badge: '28 行' },
              { ic: 'search', verb: 'grep', target: 'idempotent(', badge: '命中 5 处' },
              { ic: 'eye', verb: 'read_file', target: 'docs/adr/checkout-split.md', badge: '3 份文档交叉比对' }
            ],
            find: '补偿任务完全没有走 `idempotent()` 包装，是唯一缺口。',
            file: 'docs/adr/checkout-split.md' },
          { w: 'agent', model: 'claude-sonnet-4', time: '10:15', blocks: [
              { t: 'p', text: '已在 `callback/refund.ts` 前面加上基于 `(orderId, refundNo)` 的幂等键校验，与 @《分布式幂等键设计规范》v2.1 对齐。' }
            ],
            files: [{ n: 'src/payment/callback/refund.ts', add: 20, del: 4 }, { n: 'src/payment/state-machine.ts', add: 8, del: 2 }] },
          { w: 'plan', id: 'plan1', title: '退款幂等键补全与补偿链路对齐方案',
            steps: [
              { done: true, text: '把幂等键闸门抽到 callback/refund.ts 入口' },
              { done: true, text: '补偿任务重试前复用同一把键' },
              { done: false, text: '补 0 元券、重复回调、并发投递三类边界用例' },
              { done: false, text: '回归后把灰度和回滚步骤写回 ADR' }
            ],
            body: '先补齐键拦截再动状态机：避免一次性把迁移边和幂等改造揉在同一个提交里。补偿任务的重试入口与回调入口必须用同一把键，否则两侧会互相放行。' },
          { w: ME, time: '10:16',
            text: '补跑一次幂等回归测试，看重复回调还会不会触发二次退款。' },
          { w: 'thinking', label: '思考过程', dur: '1.9s',
            body: ['当前等待快照更新测试执行许可；待命令审批通过后复验重复回调幂等结果。'] },
          { w: 'workgroup', title: '执行回归前准备（2 步）', dur: '0.7s',
            summary: '校验桩服务配置并准备执行 vitest 快照更新',
            rows: [
              { ic: 'eye', verb: 'read_file', target: 'src/payment/callback/refund.ts', badge: '已加闸门', tone: 'ok', file: 'src/payment/callback/refund.ts',
                out: 'idempotent(`refund:${orderId}:${refundNo}`, () => refundGateway.confirm(payload))' },
              { ic: 'terminal', verb: 'vitest', target: 'src/payment/__tests__/refund-idempotency.test.ts', badge: '等待审批', tone: 'warn',
                out: '待授权：npx vitest run src/payment/__tests__/refund-idempotency.test.ts --update' }
            ] },
          { w: 'approval', id: 'a2', kind: '命令执行审批',
            code: 'npx vitest run src/payment/__tests__/refund-idempotency.test.ts --update',
            reason: '会写入快照文件并在本机启动渠道桩服务；仅影响本机工作区，不推送远端。' },
          { w: 'subagent', name: 'Test Runner', model: 'gpt-5.1-codex', state: 'running', statusText: '运行中',
            meta: '分支 feat/checkout-split · 第 2/3 个用例',
            goal: '跑幂等回归用例，确认重复回调只触发一次退款。',
            rows: [{ ic: 'terminal', verb: 'vitest', target: 'refund-idempotency.test.ts', badge: '运行中', tone: 'warn' }] },
          { w: 'sys-divider', label: '已固定引用《分布式幂等键设计规范》v2.1' },
          { w: 'sys', text: '会话保存于本机 ~/work/harness/checkout-split' }
        ] },
      { id: 's2', proj: 'p-checkout', title: '拆分支付灰度开关设计', local: true, running: false, dir: '~/work/harness/checkout-split', time: '2 小时前', unread: false,
        files: [{ n: 'config/gray-release.yml', t: '2 小时前', st: 'M' }],
        msgs: [
          { w: ME, text: '灰度开关按 workspace 维度下发，现在接口只返回 ruleId，缺 workspaceId。' },
          { w: 'tool', tool: 'edit_file', detail: 'config/gray-release.yml', file: 'config/gray-release.yml', out: '+ dimension: workspace\n+ enabled: false' },
          { w: 'agent', text: '已将配置维度切到 workspace，开关默认关闭，白名单命中才走新支付通道，回滚只需把 enabled 置回 false。' }
        ] },
      { id: 's3', proj: 'p-checkout', title: '老支付通道下线清单', local: false, running: false, dir: '~/work/harness/checkout-split', time: '昨天 21:40', unread: false,
        files: [],
        msgs: [
          { w: ME, text: '把还在调用老支付通道的模块全部扫一遍。' },
          { w: 'tool', tool: 'grep "legacyPay"', detail: '命中 7 处，分布在 3 个模块', out: 'checkout/confirm.ts (3)\norder/detail.ts (2)\nrefund/apply.ts (2)' },
          { w: 'agent', text: '清单已按调用方整理完毕：收银台、订单详情、退款入口三个模块共 7 处。其中订单详情是兜底逻辑，建议等新通道灰度到 100% 后再删。' }
        ] },
      { id: 's4', proj: 'p-bill', title: '对账单导出字段映射', local: true, running: false, dir: '~/work/harness/bill-export', time: '38 分钟前', unread: true,
        files: [{ n: 'src/export/columns.ts', t: '38 分钟前', st: 'M' }, { n: 'src/export/stream.ts', t: '昨天', st: 'A' }],
        msgs: [
          { w: ME, text: '导出列和账单中心对不上，先把映射表按 @《金额字段整数分编码规约》v1.4 补齐。' },
          { w: 'tool', tool: 'read_file', detail: 'src/export/columns.ts', file: 'src/export/columns.ts', out: "settleAmount -> settleCents (int64)\nfeeAmount -> feeCents (int64)" },
          { w: 'agent', text: '发现 settle_amount 原先除以 100 导出成了元，账单中心要求整数分。已去掉反向换算并统一改成 int64 分。' }
        ] },
      { id: 's5', proj: 'p-bill', title: '大文件流式导出方案', local: true, running: false, dir: '~/work/harness/bill-export', time: '昨天 16:02', unread: false,
        files: [{ n: 'src/export/stream.ts', t: '昨天 16:02', st: 'M' }],
        msgs: [
          { w: ME, text: '百万行对账单不能一次性内存组装，改成流式写。' },
          { w: 'tool', tool: 'edit_file', detail: 'src/export/stream.ts', out: 'Replaced array buffer with Transform stream (chunk=2000)' },
          { w: 'agent', text: '已切为 2000 行一批的分片流式写入，内存峰值稳定在 45 MB 以内。' }
        ] },
      { id: 's6', proj: 'p-bill', title: '分页游标断点续传', local: false, running: false, dir: '~/work/harness/bill-export', time: '前天 11:20', unread: false,
        files: [], msgs: [
          { w: ME, text: '游标用 update_time + id 复合，避免同一时间戳翻页丢行。' },
          { w: 'tool', tool: 'read_file', detail: 'src/export/cursor.ts', out: 'ORDER BY update_time ASC, id ASC LIMIT 500' },
          { w: 'agent', text: '已确认索引覆盖 (update_time, id),中断续传的 checkpoint 已落到导出任务表。' }
        ] },
      { id: 's7', proj: 'p-idem', title: '幂等键过期策略', local: true, running: false, dir: '~/work/harness/idempotency', time: '3 天前', unread: false,
        files: [{ n: 'src/idempotency/ttl.ts', t: '3 天前', st: 'M' }],
        msgs: [
          { w: ME, text: '幂等键 TTL 定 24 小时，和退款时效对齐。' },
          { w: 'tool', tool: 'edit_file', detail: 'src/idempotency/ttl.ts', out: 'REFUND_IDEM_TTL_SEC = 86400' },
          { w: 'agent', text: '已更新 TTL 常量并补上边界过期单测。' }
        ] },
      { id: 's8', proj: 'p-risk', title: '风控规则联调清单', local: true, running: false, dir: '~/work/harness/risk-sandbox', time: '5 小时前', unread: false,
        files: [], msgs: [
          { w: ME, text: '联调环境只开 3 条规则，先跑通链路再加规则。' },
          { w: 'tool', tool: 'read_file', detail: 'docs/risk/sandbox.md', out: 'active_rules: [R001, R004, R009]' },
          { w: 'agent', text: '已确认沙箱只启用这 3 条规则，命中与拒绝回调均已跑通。' }
        ] }
    ],
    peers: [
      { id: 'ps1', proj: 'p-checkout', owner: 'shenbeichen', title: '结账台支付方式选择器重构', sync: 'updated', time: '8 分钟前',
        brief: '把支付方式选择器从收银台页面里抽成独立组件,同时补齐禁用态与推荐位排序。',
        points: ['选择器抽成 PaymentMethodPicker,props 只留 value / onChange / context',
                 '禁用态走 disabledReason 文案，不再整块灰掉',
                 '需要后端返回 3 个新字段：enable、disabledReason、recommendScore'],
        msgs: [
          { w: 'shenbeichen', text: '把收银台里的支付方式选择逻辑抽成独立组件 PaymentMethodPicker,保留原有键盘切换。' },
          { w: 'tool', tool: 'read_file', detail: 'src/checkout/PaymentMethodPicker.tsx', out: 'Props: value, onChange, context (0 errors)' },
          { w: 'agent', text: '组件已抽取完成并替换页面引用，行为与重构前一致。当前前端仅缺后端列表接口的 enable、disabledReason、recommendScore 三个字段。' },
          { w: 'shenbeichen', text: '接口那 3 个字段我已经建任务派给大林了。' }
        ] },
      { id: 'ps2', proj: 'p-checkout', owner: 'shenbeichen', title: '订单详情页券区改版', sync: 'synced', time: '昨天 18:20',
        brief: '券区拆成可用 / 不可用两段,不可用默认折叠并给出原因。',
        points: ['券区折叠态默认收起不可用券', '不可用原因直接读接口 reason 字段'],
        msgs: [
          { w: 'shenbeichen', text: '把订单详情券区拆成可用/不可用两段,不可用默认折叠。' },
          { w: 'agent', text: '已拆完两段列表并用枚举映射兜底 reason 文案,后端补齐 reason 字段后可直接切换。' }
        ] },
      { id: 'ps3', proj: 'p-checkout', owner: 'wangdalin', title: '支付路由灰度分流', sync: 'updated', time: '26 分钟前',
        brief: '支付路由按 workspace 维度分流,灰度比例从配置中心下发。',
        points: ['路由分流键从 uid 改成 workspaceId', '灰度比例取配置中心,默认 0'],
        msgs: [
          { w: 'wangdalin', text: '分流键切到 workspaceId,保证同团队成员命中结果一致。' },
          { w: 'tool', tool: 'edit_file', detail: 'src/routing/gray-router.ts', out: 'hashKey = `${workspaceId}:${routeGroup}`' },
          { w: 'agent', text: '路由分流逻辑已改完,灰度比例默认读配置中心 0%。' }
        ] },
      { id: 'ps4', proj: 'p-checkout', owner: 'wangdalin', title: '回调重试队列压测', sync: 'unsynced', time: '3 小时前',
        brief: '回调重试队列在 500 TPS 下的堆积情况摸底,确定重试上限。',
        points: ['200 / 500 / 800 TPS 三档压测', '重试上限建议 5 次,超过进死信'],
        msgs: [
          { w: 'wangdalin', text: '跑一下 500 TPS 下回调重试队列的堆积拐点。' },
          { w: 'agent', text: '500 TPS 跑 10 分钟后堆积到 1.2 万条随后回落,重试上限定 5 次较稳,超过建议转入死信队列。' }
        ] },
      { id: 'ps5', proj: 'p-checkout', owner: 'mingfangpeng', title: '退款状态机补齐', sync: 'updated', time: '1 小时前',
        brief: '退款链路补 PARTIAL_REFUNDED 状态,并保证重复回调不重复退款。',
        points: ['新增 PARTIAL_REFUNDED 状态与两条迁移边', '幂等键取 (orderId, refundNo)'],
        msgs: [
          { w: 'mingfangpeng', text: '把 PARTIAL_REFUNDED 状态和对应迁移边补齐。' },
          { w: 'tool', tool: 'edit_file', detail: 'src/payment/refund-state.ts', out: '+ PARTIAL_REFUNDED: [PAID, REFUNDING]' },
          { w: 'agent', text: '已补充状态及两条迁移边,并通过状态迁移边界单测。' }
        ] },
      { id: 'ps6', proj: 'p-checkout', owner: 'yangkang', title: '对账补偿任务调度', sync: 'synced', time: '昨天 10:05',
        brief: '对账差异单进补偿任务,按 5 分钟一轮调度。',
        points: ['补偿任务按 shard 分片,单分片串行'],
        msgs: [
          { w: 'yangkang', text: '补偿调度按 8 分片串行执行,避免同一订单被并发修改。' },
          { w: 'agent', text: '已配置 5 分钟调度周期与指数退避重试策略。' }
        ] },
      { id: 'ps7', proj: 'p-checkout', owner: 'fengxueming', title: '收银台移动端适配', sync: 'unsynced', time: '2 天前',
        brief: '收银台在 375 宽下的支付方式列表与按钮组适配。',
        points: ['支付方式列表在小屏改成两列', '主按钮固定在底部安全区内'],
        msgs: [
          { w: 'fengxueming', text: '小屏两列排布改完了,还差后端返回禁用原因文案。' },
          { w: 'agent', text: '已验证 375px 与 390px 下底部安全区留白无遮挡。' }
        ] },
      { id: 'ps8', proj: 'p-bill', owner: 'shenbeichen', title: '导出中心列表页改版', sync: 'updated', time: '40 分钟前',
        brief: '导出中心列表加状态列与失败重试入口。',
        points: ['列表加 status 列,失败行可直接重试'],
        msgs: [
          { w: 'shenbeichen', text: '导出列表补上 status 列和失败行重试入口。' },
          { w: 'tool', tool: 'edit_file', detail: 'src/pages/export/List.tsx', out: 'Added StatusBadge + retry button' }
        ] },
      { id: 'ps9', proj: 'p-bill', owner: 'wangdalin', title: '导出任务并发限流', sync: 'synced', time: '昨天 15:30',
        brief: '同一 workspace 同时最多 3 个导出任务,超出排队。',
        points: ['按 workspaceId 做并发信号量,上限 3'],
        msgs: [
          { w: 'wangdalin', text: '按 workspace 维度加并发上限 3 的信号量,超时自动失败。' },
          { w: 'agent', text: '信号量限流与 10 分钟排队超时机制已上线测试环境。' }
        ] },
      { id: 'ps10', proj: 'p-idem', owner: 'wangdalin', title: '幂等键 Redis 集群迁移', sync: 'updated', time: '2 小时前',
        brief: '幂等键从单实例 Redis 迁到集群,注意 hash tag。',
        points: ['key 加 {idem} hash tag,避免跨 slot'],
        msgs: [
          { w: 'wangdalin', text: '核对一下迁移后的 Redis key hash tag 是否全部落入同 slot。' },
          { w: 'tool', tool: 'read_file', detail: 'src/idempotency/store.ts', out: 'keyPrefix = "pay:{idem}:"' }
        ] },
      { id: 'ps11', proj: 'p-idem', owner: 'mingfangpeng', title: '幂等键生成器压测', sync: 'synced', time: '昨天 09:12',
        brief: '幂等键生成器单机 2 万 QPS 压测,看 P99 延迟。',
        points: ['单机 2 万 QPS,P99 1.8ms'],
        msgs: [
          { w: 'mingfangpeng', text: '压测一下单机 2 万 QPS 下生成器的耗时分布。' },
          { w: 'agent', text: 'P99 延迟为 1.8ms,瓶颈在 Redis RTT 而不是生成器本身。' }
        ] },
      { id: 'ps12', proj: 'p-idem', owner: 'yangkang', title: '重复请求拦截日志', sync: 'unsynced', time: '前天 17:40',
        brief: '重复请求被幂等拦截后补结构化日志,方便排查。',
        points: ['拦截日志带 key、首次请求 traceId'],
        msgs: [
          { w: 'yangkang', text: '拦截日志里把首次请求 traceId 带上,方便链路串联。' },
          { w: 'agent', text: '已补充 traceId 与按天采样开关,避免日志打爆磁盘。' }
        ] },
      { id: 'ps13', proj: 'p-risk', owner: 'mingfangpeng', title: '风控规则引擎联调', sync: 'updated', time: '1 小时前',
        brief: '沙箱环境联调 3 条规则,验证命中与拒绝链路。',
        points: ['3 条规则全部命中,拒绝链路正常'],
        msgs: [
          { w: 'mingfangpeng', text: '跑一遍沙箱 3 条规则的拒绝链路回归。' },
          { w: 'tool', tool: 'read_file', detail: 'docs/risk/sandbox.md', out: '3/3 rules matched expected action' }
        ] },
      { id: 'ps14', proj: 'p-risk', owner: 'fengxueming', title: '风控结果页展示', sync: 'unsynced', time: '3 天前',
        brief: '风控结果页展示命中的规则名与处置动作。',
        points: ['结果页需要 ruleName 与 action 两个字段'],
        msgs: [
          { w: 'fengxueming', text: '结果页样式写完了,等后端补充 ruleName 和 action 字段。' }
        ] }
    ],
    tasks: [
      { id: 't0', proj: 'p-checkout', title: '灰度白名单接口补 workspaceId', from: 'shenbeichen', to: 'zhangjingxin',
        status: 'open', prio: 'high', time: '今天 10:12',
        desc: '灰度白名单按 workspace 下发,但接口只返回了 ruleId。需要补 workspaceId 字段,前端才能按团队过滤白名单。',
        sessionId: null, src: 'session', srcTitle: '灰度白名单前端联调' },
      { id: 't1', proj: 'p-checkout', title: '支付方式列表接口缺 3 个字段', from: 'shenbeichen', to: 'wangdalin',
        status: 'open', prio: 'high', time: '今天 10:24',
        desc: '支付方式列表需要 enable、disabledReason、recommendScore 三个字段。现在前端只能整块灰掉,无法给出禁用原因。',
        sessionId: null },
      { id: 't2', proj: 'p-checkout', title: '券金额精度校验补单元测试', from: 'shenbeichen', to: 'mingfangpeng',
        status: 'open', prio: 'mid', time: '今天 09:30',
        desc: '券金额从元改成整数分之后,缺少边界用例。补 0 元券、满减后负值、按比例取整三类用例。',
        sessionId: null },
      { id: 't3', proj: 'p-checkout', title: '回调时序补充 refund 分支', from: ME, to: 'yangkang',
        status: 'running', prio: 'high', time: '昨天 19:40', live: true,
        desc: '回调时序文档只画了支付成功分支,补上 refund 与 partial refund 两条路径,并标注幂等键位置。',
        sessionId: 's1' },
      { id: 't4', proj: 'p-checkout', title: '支付方式禁用态接口约定', from: 'fengxueming', to: 'zhangjingxin',
        status: 'claimed', prio: 'mid', time: '昨天 16:05',
        desc: '禁用态需要后端明确返回 disabledReason 枚举,前端不再自己拼文案。约定枚举值:maintenance、unavailable、limit。',
        sessionId: null },
      { id: 't5', proj: 'p-bill', title: '导出接口支持游标分页', from: 'fengxueming', to: 'zhangjingxin',
        status: 'open', prio: 'high', time: '今天 11:02',
        desc: '导出中心需要按游标分页拉取历史导出任务,现在只有一次性全量返回,数据量大了会超时。',
        sessionId: null },
      { id: 't6', proj: 'p-bill', title: '导出任务失败重试上限配置化', from: ME, to: 'wangdalin',
        status: 'done', prio: 'mid', time: '昨天 11:20',
        desc: '重试上限从硬编码 3 次改成配置项,默认仍为 3,超过进死信队列。',
        sessionId: null },
      { id: 't7', proj: 'p-idem', title: '幂等键冲突时返回原始结果', from: 'wangdalin', to: 'yangkang',
        status: 'open', prio: 'high', time: '今天 09:05',
        desc: '重复请求命中幂等键时,现在返回 409。业务方要求直接返回首次请求的结果,避免前端重试。',
        sessionId: null },
      { id: 't8', proj: 'p-risk', title: '风控结果页需要 ruleName 字段', from: 'fengxueming', to: 'mingfangpeng',
        status: 'open', prio: 'mid', time: '今天 10:40',
        desc: '风控结果页要展示命中的规则名,接口目前只返回规则 id。补 ruleName 与 action 两个字段。',
        sessionId: null },
      { id: 't9', proj: 'p-checkout', title: '拆单支付灰度开关接入配置中心', from: ME, to: 'wangdalin',
        status: 'running', prio: 'mid', time: '3 天前', stale: '3 天未更新',
        desc: '灰度开关从本地常量迁到配置中心,支持按商户维度放量。',
        sessionId: null },
      { id: 't10', proj: 'p-checkout', title: '支付结果页埋点补齐', from: 'shenbeichen', to: 'fengxueming',
        status: 'running', prio: 'low', time: '今天 08:50', live: true,
        desc: '结果页补齐成功、失败、超时三类曝光埋点。',
        sessionId: null },
      { id: 't11', proj: 'p-checkout', title: '退款回调验签改用新证书', from: 'shenbeichen', to: 'zhangjingxin',
        status: 'done', prio: 'high', time: '前天',
        desc: '渠道证书轮换,回调验签切换到新证书,旧证书保留 7 天兜底。',
        sessionId: null },
      { id: 't12', proj: 'p-checkout', title: '券核销接口超时重试', from: ME, to: 'mingfangpeng',
        status: 'done', prio: 'mid', time: '昨天 15:10',
        desc: '核销接口超时后按幂等键重试一次,超过转人工。',
        sessionId: null },
      { id: 't13', proj: 'p-idem', title: '幂等键 TTL 监控告警', from: 'yangkang', to: 'wangdalin',
        status: 'claimed', prio: 'mid', time: '今天 09:40',
        desc: 'TTL 过期命中率超过阈值时告警,接入现有监控大盘。',
        sessionId: null }
    ],
    knowledge: [
      { id: 'k1', scope: 'workspace', ws: 'ws-base', proj: null, title: '金额字段整数分编码规约', author: ME,
        version: 'v1.4', updated: '2025-11-02',
        sum: '所有金额字段统一使用 int64 整数分存储与传输，禁止浮点与字符串。',
        body: '1. 存储与 Protobuf/JSON 传输一律采用 int64 单位「分」（Cents），字段命名固定以 Cents 结尾（如 settleCents、feeCents）。\n2. 严禁在网关或导出中间件里私自乘除 100；跨语言序列化保持原值透传。\n3. 仅前端 UI 展示层统一除以 100 并保留两位小数，舍入策略统一采用银行家舍入。' },
      { id: 'k2', scope: 'workspace', ws: 'ws-base', proj: null, title: '分布式幂等键设计规范', author: 'wangdalin',
        version: 'v2.1', updated: '2025-10-19',
        sum: '幂等键按业务主键组合并加 {idem} hash tag，TTL 统一 24 小时，冲突时返回首次结果。',
        body: '1. Key 格式：pay:{idem}:<bizType>:<orderId>:<subNo>，必须携带 {idem} 保证 Redis 集群同 slot。\n2. 有效期：支付与退款链路统一 24h，查询类链路缩短为 2h。\n3. 重入语义：并发执行中返回 409 PROCESSING；已完成态幂等返回首次成功载荷，禁止二次触发下游网关。' },
      { id: 'k3', scope: 'workspace', ws: 'ws-base', proj: null, title: '交易域基础术语表', author: 'fengxueming',
        version: 'v1.0', updated: '2025-09-08',
        sum: '统一支付、结算、对账、退款四个子域的中英文命名，避免前后端字段各写一套。',
        body: '• 收单支付（Acquiring / Pay）：tradeNo（交易号）、payChannel（支付通道）、disabledReason（禁用枚举）。\n• 清分结算（Settlement）：settleCents、feeCents、merchantId。\n• 对账差异（Reconciliation）：diffType、compensateTaskId、checkpoint。\n• 退款（Refund）：refundNo、PARTIAL_REFUNDED、refundGateway。' },
      { id: 'k4', scope: 'project', ws: 'ws-base', proj: 'p-checkout', title: '拆分支付状态机与回调时序 ADR', author: ME,
        version: 'v3.0', updated: '2025-11-20',
        sum: '拆分后状态收敛为 PAID / REFUNDING / PARTIAL_REFUNDED 三态，回调入口统一走幂等闸门。',
        body: '【背景】拆分支付上线后存在部分退款与异步补偿并发到达的问题。\n【决策】\n- 状态迁移仅允许 PAID → REFUNDING / PARTIAL_REFUNDED，PARTIAL_REFUNDED → REFUNDING。\n- callback/refund.ts 与 job/compensate.ts 必须共用同一套 idempotent(orderId, refundNo) 闸门，补偿任务不得跳过状态校验直接改库。' },
      { id: 'k5', scope: 'project', ws: 'ws-base', proj: 'p-bill', title: '对账单导出字段映射', author: 'shenbeichen',
        version: 'v1.2', updated: '2025-11-18',
        sum: '定义导出中心 CSV/Excel 列与账单中心接口字段的一一映射及时区标准。',
        body: '1. 交易号 tradeNo -> 对账中心 bill_trade_no（字符串原样导出）。\n2. 结算金额 settleCents / 手续费 feeCents -> 均按整数分输出，由对账中心统一格式化。\n3. 交易时间 gmtCreate -> 严格采用 ISO-8601 UTC（+00:00）输出，禁止不带时区的本地时间字符串。' },
      { id: 'k6', scope: 'project', ws: 'ws-base', proj: 'p-idem', title: '幂等键过期策略决策记录', author: 'mingfangpeng',
        version: 'v1.0', updated: '2025-11-09',
        sum: '按链路风险等级拆分 TTL：退款 24 小时，普通查询 2 小时以控制内存水位。',
        body: '压测表明所有接口都走 24 小时 TTL 会使 Redis 内存上涨 38%。因此：\n- 资金写入与退款回调链路保持 86400s；\n- 只读幂等校验或导出状态轮询降为 7200s；\n- 过期阈值通过配置中心热更新，无需发版。' },
      { id: 'k7', scope: 'project', ws: 'ws-risk', proj: 'p-risk', title: '风控规则联调字段约定', author: 'mingfangpeng',
        version: 'v1.0', updated: '2025-11-14',
        sum: '联调沙箱阶段规则响应固定返回 ruleId、ruleName、action、score 四个字段。',
        body: '沙箱联调期间冻结以下响应体结构：\n{ ruleId: string, ruleName: string, action: "PASS" | "REVIEW" | "REJECT", score: number }\n前端结果页直接消费 ruleName 与 action 展示处置说明，联调结束前不再扩充额外字段。' }
    ]
  };

  /* ═══════════ HC-243 团队系统地图（Workspace 已发布版本） ═══════════
     仓库职责与关系只从这里读：证据文件路径为空的关系标为「推测」。 */
  var SYS_MAP = {
    version: 'v1.2', status: '已发布', updated: '2025-11-21', publisher: 'wangdalin',
    repos: [
      { name: 'checkout-split', duty: '收银台拆分支付：状态机、回调入口与灰度开关', local: '~/work/harness/checkout-split',
        rel: [ { to: 'common-proto', kind: '共享契约', ev: 'checkout-split/package.json', sure: true },
               { to: 'order-service', kind: '调用', ev: 'checkout-split/src/order/orderClient.ts', sure: true },
               { to: 'ledger-service', kind: '调用', ev: 'checkout-split/src/ledger/ledgerClient.ts', sure: true },
               { to: 'pay-gateway', kind: '调用', ev: '', sure: false } ] },
      { name: 'order-service', duty: '订单主数据与退款单落库', local: '~/work/harness/order-service',
        rel: [ { to: 'common-proto', kind: '共享契约', ev: 'order-service/package.json', sure: true },
               { to: 'ledger-service', kind: '共享契约', ev: '../billing/src/config.ts', sure: true } ] },
      { name: 'common-proto', duty: '跨仓库共享的 Protobuf / 枚举契约', local: '~/work/harness/common-proto', rel: [] },
      { name: 'pay-gateway', duty: '渠道网关：退款与对账回调', local: '',
        rel: [ { to: 'common-proto', kind: '共享契约', ev: 'common-proto/refund.proto', sure: true } ] },
      { name: 'ledger-service', duty: '账务记账与对账差异单（团队旧名 billing）', local: '~/work/harness/ledger-service',
        upstream: 'pay/billing',
        rel: [ { to: 'common-proto', kind: '共享契约', ev: 'ledger-service/go.mod', sure: true },
               { to: 'pay-gateway', kind: '调用', ev: '', sure: false } ] },
      { name: 'bill-export', duty: '对账单异步导出与分片流', local: '~/work/harness/bill-export',
        rel: [ { to: 'common-proto', kind: '共享契约', ev: 'bill-export/package.json', sure: true },
               { to: 'order-service', kind: '调用', ev: 'bill-export/src/export/source.ts', sure: true } ] },
      { name: 'idempotency', duty: '幂等键服务与 TTL 过期兜底', local: '~/work/harness/idempotency',
        rel: [ { to: 'common-proto', kind: '共享契约', ev: 'idempotency/go.mod', sure: true } ] },
      { name: 'risk-sandbox', duty: '风控联调沙箱，隔离线上主链路', local: '~/work/harness/risk-sandbox',
        rel: [ { to: 'pay-gateway', kind: '调用', ev: 'risk-sandbox/docs/risk/sandbox.md', sure: true } ] }
    ]
  };
  var WS_REPOS = {
    'ws-base': ['checkout-split', 'order-service', 'common-proto', 'pay-gateway', 'ledger-service', 'bill-export', 'idempotency'],
    'ws-risk': ['risk-sandbox', 'pay-gateway', 'common-proto']
  };
  /* 本机记忆（team.md / personal.md）。personal 里的 conflict 条目与已发布地图不一致。 */
  var MEM = {
    team: [
      { id: 'tm1', key: 'checkout-split → common-proto', text: 'checkout-split 依赖 common-proto 的支付契约；本机副本在 ~/work/harness/common-proto。', src: 'team.md · 2025-11-21' },
      { id: 'tm2', key: 'billing ≡ ledger-service', text: '队友口中的 billing 工程就是本机 ledger-service（个人 fork 自 pay/billing）。', src: 'team.md · 2025-11-21' },
      { id: 'tm3', key: '幂等键 TTL', text: '退款链路幂等键 TTL 24h，只读查询 2h。', src: 'team.md · 2025-11-18' }
    ],
    personal: [
      { id: 'pm1', key: 'billing → bill-export', text: '本机把 order-service 里的 ../billing 指向 bill-export，便于复用导出列映射。',
        src: 'personal.md · 2025-11-21', conflict: '已发布系统地图记录 ../billing/src/config.ts 属于 ledger-service，以地图为准。' },
      { id: 'pm2', key: 'pay-gateway', text: 'pay-gateway 本机未克隆，需要时走远端只读，不做本地改动。', src: 'personal.md · 2025-11-20' }
    ]
  };
  var LEVEL_TEXT = { rule: '规约', exp: '经验', term: '术语', map: '系统地图' };
  var LEVEL_NOTE = { rule: '范围匹配时正文每轮直带', exp: '标题目录 + 按需读取', term: '标题目录 + 按需读取', map: 'team.md 权威来源' };

  /* ═══════════ 工具函数 ═══════════ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  /* 渲染入口:把模板字符串变成真实 DOM 节点。所有插入的值都先过 esc(),
     所以这里用 fragment 解析而不是直接写 innerHTML。 */
  function put(target, html) {
    var el = typeof target === 'string' ? $(target) : target;
    if (!el) return null;
    el.replaceChildren(document.createRange().createContextualFragment(String(html == null ? '' : html)));
    return el;
  }
  var segSnap = {};
  function captureSegs(root) {
    $$('[data-seg-key]', root || document).forEach(function (box) {
      var k = box.getAttribute('data-seg-key');
      var active = box.querySelector('button.is-on, button.is-active');
      if (!active) return;
      var br = box.getBoundingClientRect(), ar = active.getBoundingClientRect();
      if (ar.width > 0) segSnap[k] = { x: ar.left - br.left, w: ar.width };
    });
  }
  function animateSegs(root) {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $$('[data-seg-key]', root || document).forEach(function (box) {
      var k = box.getAttribute('data-seg-key');
      var active = box.querySelector('button.is-on, button.is-active');
      if (!active) return;
      var br = box.getBoundingClientRect(), ar = active.getBoundingClientRect();
      if (!ar.width) return;
      var nx = ar.left - br.left, nw = ar.width;
      var prev = segSnap[k];
      var thumb = box.querySelector(':scope > .seg-thumb');
      if (!thumb) {
        thumb = document.createElement('span');
        thumb.className = 'seg-thumb'; thumb.setAttribute('aria-hidden', 'true');
        box.insertBefore(thumb, box.firstChild);
      }
      if (!reduced && prev && (Math.abs(prev.x - nx) > 1 || Math.abs(prev.w - nw) > 1)) {
        thumb.style.transition = 'none';
        thumb.style.transform = 'translateX(' + prev.x + 'px)';
        thumb.style.width = prev.w + 'px';
        thumb.getBoundingClientRect();
        thumb.style.transition = '';
      }
      thumb.style.transform = 'translateX(' + nx + 'px)';
      thumb.style.width = nw + 'px';
      segSnap[k] = { x: nx, w: nw };
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function icon(name, size) {
    return '<svg class="od-icon" style="--od-icon-size:' + (size || 16) + 'px" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  function av(id, size) {
    var p = PEOPLE[id];
    if (!p) return '';
    var s = size || 26;
    if (!p.avatar) return '<span class="av c4-initial" aria-hidden="true" style="--av:' + s + 'px">本</span>';
    return '<img class="av" src="' + AV + p.avatar + '" alt="' + esc(p.name) + '" width="' + s + '" height="' + s + '" decoding="async" style="--av:' + s + 'px">';
  }

  var WORKSPACES = [
    { id: 'ws-base', name: '基础交易研发组', members: ['zhangjingxin','shenbeichen','wangdalin','mingfangpeng','yangkang','fengxueming'] },
    { id: 'ws-risk', name: '风控联调虚拟专项组', members: ['zhangjingxin','mingfangpeng','fengxueming'] }
  ];

  var NO_TEAM = { id: null, name: '无团队', members: [] };
  var NO_PROJECT = { id: null, name: '个人工作台', members: [], repo: '' };
  function wsById(id) { return WORKSPACES.filter(function (w) { return w.id === id; })[0] || NO_TEAM; }
  function curWs() { return wsById(state.ws); }
  function curProj() { return projById(state.proj) || NO_PROJECT; }
  function projById(id) { return state.projects.filter(function (p) { return p.id === id; })[0]; }
  function teamRole(ws, person) { var team = wsById(ws); return team.members.includes(person) ? (team.roles[person] || '开发者') : ''; }
  function isAdmin(ws) { return teamRole(ws, ME) === '管理员'; }
  function projectAccess(p) { return !!(p && teamRole(p.ws, ME) && p.members.includes(ME)); }
  function wsProjects() { return state.projects.filter(function (p) { return p.ws === state.ws && projectAccess(p); }); }
  function mySessions() { return state.sessions.filter(function (s) { return s.owner === ME; }); }
  function localSessions() { return mySessions().filter(function (s) { return s.team === state.ws; }); }
  function curSession() { return mySessions().filter(function (s) { return s.id === state.session; })[0] || null; }
  function snapshotKey(p) { return ME + ':' + p.owner + ':' + p.id; }
  function peerIsSynced(p) { return state.synced[snapshotKey(p)]; }
  function peersOf(projId) {
    if (!projectAccess(projById(projId))) return [];
    var rows = state.peers.filter(function (p) { return p.proj === projId && p.owner !== ME && !p.sessionId; });
    state.sessions.forEach(function (s) {
      if (s.owner === ME || s.shareProject !== projId) return;
      rows.push({ id: s.peerId || 'shared-' + s.id, owner: s.owner, proj: projId, title: s.title, time: s.time, sync: 'unsynced',
        brief: s.shareBrief || '已发布到 Project，成员可主动同步定稿正文。', points: ['仅共享定稿对话，不包含草稿、自动材料或本机记忆。'],
        msgs: s.msgs.slice(0, s.msgs.findLastIndex(function (m) { return m.w === 'agent'; }) + 1).filter(function (m) { return m.w === s.owner || m.w === 'agent'; }).map(function (m) {
          return { w: m.w, time: m.time, text: m.text, blocks: m.blocks };
        }) });
    });
    Object.values(state.synced).forEach(function (copy) {
      if (copy.reader === ME && copy.proj === projId && !rows.some(function (p) { return p.id === copy.id; })) {
        rows.push(Object.assign({}, copy, { sync: 'synced', archived: true }));
      }
    });
    return rows;
  }
  function tasksOf(projId) { return state.tasks.filter(function (t) { return t.proj === projId; }); }
  function taskById(id) { return state.tasks.filter(function (t) { return t.id === id; })[0]; }
  function peerById(id) { return state.projects.flatMap(function (p) { return peersOf(p.id); }).find(function (p) { return p.id === id; }); }
  function curPeer() { return state.cross ? peerById(state.cross.id) : null; }
  function teammates() {
    var p = curProj();
    return p ? p.members.filter(function (m) { return m !== ME; }) : [];
  }
  function hasUpdate(owner) {
    return peersOf(state.proj).some(function (s) { return s.owner === owner && s.sync === 'updated'; });
  }
  function todoCount() {
    return tasksOf(state.proj).filter(function (t) {
      return t.to === ME && (t.status === 'open' || t.status === 'claimed');
    }).length;
  }
  function knowledgeForScope() {
    return state.knowledge.filter(function (k) { return k.ws === state.ws; });
  }
  function atKnowledge() {
    var s = curSession();
    return {
      ws: s && teamRole(s.team, ME) ? state.knowledge.filter(function (k) { return k.ws === s.team; }) : [],
      proj: []
    };
  }

  var STATUS_TEXT = { open: '待接受', claimed: '待开始', running: '进行中', done: '已完成', declined: '已拒绝' };
  var SYNC_TEXT = { updated: '有更新', synced: '已同步', unsynced: '未同步' };
  var PRIO_TEXT = { high: '高', mid: '中', low: '低' };

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2400);
  }

  function applyFocus() {
    if (!state.focusKey) return;
    var el = document.querySelector('[data-focus="' + state.focusKey + '"]');
    state.focusKey = null;
    if (el && el.focus) el.focus();
  }

  /* ═══════════ 渲染:侧栏 ═══════════ */
  /* ═══════════ 文件预览样本(演示内容,不读真实磁盘) ═══════════ */
  var CODE = {
    'src/payment/state-machine.ts': {
      st: 'M',
      code: [
        "import { PaymentState } from './types';",
        '',
        'const TRANSITIONS: Record<PaymentState, PaymentState[]> = {',
        "  INIT: ['PAID', 'CLOSED'],",
        "  PAID: ['REFUNDING', 'PARTIAL_REFUNDED'],",
        "  REFUNDING: ['REFUNDED'],",
        "  PARTIAL_REFUNDED: ['REFUNDING'],",
        "  REFUNDED: [], CLOSED: []",
        '};',
        '',
        'export function canTransit(from: PaymentState, to: PaymentState) {',
        '  return (TRANSITIONS[from] || []).includes(to);',
        '}'
      ],
      diff: [
        '@@ -8,4 +8,6 @@  src/payment/state-machine.ts',
        "   PAID: ['REFUNDING', 'PARTIAL_REFUNDED'],",
        "-  REFUNDING: ['REFUNDED'],",
        "+  REFUNDING: ['REFUNDED', 'PARTIAL_REFUNDED'],",
        "+  PARTIAL_REFUNDED: ['REFUNDING'],",
        "   REFUNDED: [], CLOSED: []"
      ]
    },
    'src/payment/callback/refund.ts': {
      st: 'M',
      code: [
        "import { idempotent } from '../../idempotency';",
        '',
        'export async function onRefundCallback(payload: RefundPayload) {',
        '  const key = `refund:${payload.orderId}:${payload.refundNo}`;',
        '  return idempotent(key, async () => {',
        '    if (!canTransit(payload.state, "REFUNDED")) return { skipped: true };',
        '    return refundGateway.confirm(payload);',
        '  });',
        '}'
      ],
      diff: [
        '@@ -3,3 +3,7 @@  src/payment/callback/refund.ts',
        ' export async function onRefundCallback(payload: RefundPayload) {',
        "+  const key = `refund:${payload.orderId}:${payload.refundNo}`;",
        '+  return idempotent(key, async () => {',
        '     if (!canTransit(payload.state, "REFUNDED")) return { skipped: true };',
        '     return refundGateway.confirm(payload);',
        '+  });'
      ]
    },
    'config/gray-release.yml': {
      st: 'M',
      code: [
        'grayRelease:',
        '  enabled: false',
        '  dimension: workspace',
        '  whitelist: []',
        '  rollout:',
        '    - workspaceId: ws-base',
        '      percent: 30',
        '    - workspaceId: ws-risk',
        '      percent: 0'
      ],
      diff: [
        '@@ -1,3 +1,6 @@  config/gray-release.yml',
        ' grayRelease:',
        '-  enabled: true',
        '+  enabled: false',
        '   dimension: workspace',
        '+  whitelist: []'
      ]
    },
    'src/export/columns.ts': {
      st: 'M',
      code: [
        'export const COLUMNS = [',
        "  { key: 'tradeNo', label: '交易号' },",
        "  { key: 'settleCents', label: '结算金额(分)', type: 'int64' },",
        "  { key: 'feeCents', label: '手续费(分)', type: 'int64' },",
        "  { key: 'gmtCreate', label: '交易时间', type: 'datetime' }",
        '] as const;'
      ],
      diff: [
        '@@ -2,3 +2,3 @@  src/export/columns.ts',
        "   { key: 'tradeNo', label: '交易号' },",
        "-  { key: 'settleAmount', label: '结算金额' },",
        "+  { key: 'settleCents', label: '结算金额(分)', type: 'int64' },",
        "   { key: 'feeCents', label: '手续费(分)', type: 'int64' },"
      ]
    },
    'docs/adr/checkout-split.md': {
      st: 'A',
      code: [
        '# ADR:拆分支付状态机',
        '',
        '## 背景',
        '拆分后回调可能早于订单落库,需要统一幂等闸门。',
        '',
        '## 决策',
        '- 状态收敛为 INIT / PAID / REFUNDING / PARTIAL_REFUNDED / REFUNDED / CLOSED',
        '- 回调入口先落幂等键,重复回调直接返回上次结果'
      ],
      diff: [
        '@@ -0,0 +1,8 @@  docs/adr/checkout-split.md',
        '+# ADR:拆分支付状态机',
        '+## 背景',
        '+拆分后回调可能早于订单落库,需要统一幂等闸门。'
      ]
    }
  };

  function baseName(p) { return String(p || '').split('/').pop(); }

  function defaultCode(f) {
    return ['// ' + f, '// 预览为演示内容:原型不读取真实磁盘。', '', 'export interface FilePreview {',
      '  path: string;', '  changedAt: string;', '}', '', 'export const preview: FilePreview = {',
      "  path: '" + f + "',", "  changedAt: '刚刚'", '};'];
  }
  function defaultDiff(f) {
    return ['@@ -1,1 +1,4 @@  ' + f, '-export const preview = {};', '+export const preview: FilePreview = {',
      "+  path: '" + f + "',", "+  changedAt: '刚刚'", '+};'];
  }

  function stClass(st) { return st === 'A' ? 'a' : (st === 'U' ? 'u' : 'm'); }
  function langOf(p) {
    var ext = (String(p).split('.').pop() || '').toLowerCase();
    var map = { ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', yml: 'YAML', yaml: 'YAML', md: 'Markdown', go: 'Go', json: 'JSON', css: 'CSS' };
    return map[ext] || 'Text';
  }
  function stOf(p) {
    var s = curSession();
    var hit = ((s && s.files) || []).filter(function (f) { return f.n === p; })[0];
    return (hit && hit.st) || 'M';
  }
  var GIT_LOGS = {
    'p-checkout': [
      { sha: 'a83f2c1', msg: 'feat: 状态机补充 PARTIAL_REFUNDED 迁移边', author: '张景新', time: '2 小时前', head: true, ahead: true,
        files: [{ n: 'src/payment/state-machine.ts', st: 'M' }, { n: 'docs/adr/checkout-split.md', st: 'A' }] },
      { sha: '7d19e04', msg: 'fix: 回调入口提取 (orderId, refundNo) 幂等键', author: '明方鹏', time: '昨天 20:15', ahead: true,
        files: [{ n: 'src/payment/callback/refund.ts', st: 'M' }] },
      { sha: '4c92b10', msg: 'chore: 灰度开关配置按 workspaceId 分流', author: '王大林', time: '昨天 16:40', ahead: false,
        files: [{ n: 'config/gray-release.yml', st: 'M' }] },
      { sha: '1e05f8a', msg: 'feat: 初始化 checkout-split 状态机骨架', author: '张景新', time: '前天 11:20', ahead: false,
        files: [{ n: 'src/payment/state-machine.ts', st: 'A' }] }
    ],
    'p-bill': [
      { sha: 'e51d90b', msg: 'fix: 结算金额字段统一改用 int64 整数分', author: '张景新', time: '1 小时前', head: true, ahead: true,
        files: [{ n: 'src/export/columns.ts', st: 'M' }] },
      { sha: '9b40c31', msg: 'perf: 对账单导出切为 2000 行分片流式写入', author: '王大林', time: '昨天 15:45', ahead: false,
        files: [{ n: 'src/export/stream.ts', st: 'M' }] }
    ],
    'p-idem': [
      { sha: '3f8a12d', msg: 'chore: 退款幂等键 TTL 对齐 24 小时', author: '张景新', time: '3 天前', head: true, ahead: false,
        files: [{ n: 'src/idempotency/ttl.ts', st: 'M' }] }
    ],
    'p-risk': [
      { sha: 'c209f4e', msg: 'docs: 锁定风控联调沙箱 3 条回归规则', author: '明方鹏', time: '5 小时前', head: true, ahead: false,
        files: [{ n: 'docs/risk/sandbox.md', st: 'M' }] }
    ]
  };
  var STRESS_CHANGES = [
    { n: 'src/payment/state-machine.ts', st: 'M', add: 14, del: 3 },
    { n: 'src/payment/callback/refund.ts', st: 'M', add: 22, del: 5 },
    { n: 'src/payment/callback/notify.ts', st: 'M', add: 9, del: 4 },
    { n: 'src/payment/callback/signature.ts', st: 'M', add: 18, del: 11 },
    { n: 'src/payment/callback/retry-queue.ts', st: 'A', add: 64, del: 0 },
    { n: 'src/payment/gateway/alipay-adapter.ts', st: 'M', add: 31, del: 18 },
    { n: 'src/payment/gateway/wechat-adapter.ts', st: 'M', add: 27, del: 14 },
    { n: 'src/payment/gateway/channel-router.ts', st: 'M', add: 16, del: 8 },
    { n: 'src/payment/gateway/fallback-guard.ts', st: 'A', add: 45, del: 0 },
    { n: 'src/order/split/allocator.ts', st: 'M', add: 38, del: 19 },
    { n: 'src/order/split/ledger-sync.ts', st: 'M', add: 12, del: 7 },
    { n: 'src/order/split/settlement.ts', st: 'M', add: 21, del: 9 },
    { n: 'src/order/detail/query-service.ts', st: 'M', add: 7, del: 3 },
    { n: 'config/gray-release.yml', st: 'M', add: 6, del: 2 },
    { n: 'config/routes/checkout.yml', st: 'M', add: 11, del: 4 },
    { n: 'docs/adr/checkout-split.md', st: 'A', add: 58, del: 0 },
    { n: 'docs/runbook/refund-replay.md', st: 'U', add: 32, del: 0 },
    { n: 'tests/payment/state-machine.test.ts', st: 'M', add: 44, del: 6 },
    { n: 'tests/payment/callback/refund.test.ts', st: 'A', add: 89, del: 0 },
    { n: 'tests/payment/gateway/router.test.ts', st: 'M', add: 19, del: 10 },
    { n: 'tests/order/split/allocator.test.ts', st: 'M', add: 25, del: 12 },
    { n: 'tests/fixtures/mock-notify.json', st: 'U', add: 40, del: 0 }
  ];
  var STRESS_LOGS = [
    { sha: 'a83f2c1', msg: 'feat: 状态机补充 PARTIAL_REFUNDED 迁移边与回调幂等校验', author: '张景新', time: '25 分钟前', head: true, ahead: true,
      files: [
        { n: 'src/payment/state-machine.ts', st: 'M' },
        { n: 'src/payment/callback/refund.ts', st: 'M' },
        { n: 'src/payment/callback/notify.ts', st: 'M' },
        { n: 'src/payment/callback/signature.ts', st: 'M' },
        { n: 'src/payment/callback/retry-queue.ts', st: 'A' },
        { n: 'src/payment/gateway/channel-router.ts', st: 'M' },
        { n: 'src/order/split/allocator.ts', st: 'M' },
        { n: 'tests/payment/state-machine.test.ts', st: 'M' },
        { n: 'tests/payment/callback/refund.test.ts', st: 'A' },
        { n: 'config/gray-release.yml', st: 'M' },
        { n: 'docs/adr/checkout-split.md', st: 'A' }
      ] },
    { sha: '9e41b02', msg: 'refactor: 抽离渠道网关 fallback-guard 熔断保护', author: '明方鹏', time: '2 小时前', ahead: true,
      files: [{ n: 'src/payment/gateway/fallback-guard.ts', st: 'A' }, { n: 'src/payment/gateway/alipay-adapter.ts', st: 'M' }, { n: 'src/payment/gateway/wechat-adapter.ts', st: 'M' }] },
    { sha: '7d19e04', msg: 'fix: 回调入口统一提取 (orderId, refundNo) 幂等键', author: '明方鹏', time: '4 小时前', ahead: true,
      files: [{ n: 'src/payment/callback/refund.ts', st: 'M' }, { n: 'tests/payment/callback/refund.test.ts', st: 'A' }] },
    { sha: '5a0c8d3', msg: 'chore: 补全拆分账单对账单分摊测试用例', author: '王大林', time: '昨天 21:10', ahead: true,
      files: [{ n: 'src/order/split/allocator.ts', st: 'M' }, { n: 'tests/order/split/allocator.test.ts', st: 'M' }] },
    { sha: '4c92b10', msg: 'chore: 灰度开关配置按 workspaceId 分流', author: '王大林', time: '昨天 16:40', ahead: false,
      files: [{ n: 'config/gray-release.yml', st: 'M' }, { n: 'config/routes/checkout.yml', st: 'M' }] },
    { sha: '3b78f19', msg: 'fix: 补齐部分退款后子订单账本冲正偏移计算', author: '杨康', time: '昨天 11:25', ahead: false,
      files: [{ n: 'src/order/split/ledger-sync.ts', st: 'M' }, { n: 'src/order/split/settlement.ts', st: 'M' }] },
    { sha: '2f14e6a', msg: 'feat: 订单详情接口兼容老支付通道兜底标记', author: '沈北辰', time: '前天 19:50', ahead: false,
      files: [{ n: 'src/order/detail/query-service.ts', st: 'M' }] },
    { sha: '1e05f8a', msg: 'feat: 初始化 checkout-split 状态机骨架', author: '张景新', time: '前天 11:20', ahead: false,
      files: [{ n: 'src/payment/state-machine.ts', st: 'A' }, { n: 'tests/payment/state-machine.test.ts', st: 'A' }] },
    { sha: '0d89c44', msg: 'docs: 记录拆单支付网关幂等设计 ADR 决议', author: '张景新', time: '3 天前', ahead: false,
      files: [{ n: 'docs/adr/checkout-split.md', st: 'A' }] },
    { sha: 'fa3201b', msg: 'test: 添加微信/支付宝异步通知验签回归夹具', author: '明方鹏', time: '3 天前', ahead: false,
      files: [{ n: 'tests/fixtures/mock-notify.json', st: 'A' }, { n: 'src/payment/callback/signature.ts', st: 'M' }] },
    { sha: 'ea118c7', msg: 'perf: 减少路由表热点路径正则编译开销', author: '王大林', time: '4 天前', ahead: false,
      files: [{ n: 'src/payment/gateway/channel-router.ts', st: 'M' }, { n: 'tests/payment/gateway/router.test.ts', st: 'M' }] },
    { sha: 'd409b22', msg: 'fix: 修复退款异步补偿队列重复投递死信问题', author: '杨康', time: '4 天前', ahead: false,
      files: [{ n: 'src/payment/callback/retry-queue.ts', st: 'M' }] },
    { sha: 'c772e10', msg: 'chore: 对齐网关错误码映射到标准结算错误枚举', author: '张景新', time: '5 天前', ahead: false,
      files: [{ n: 'src/payment/gateway/alipay-adapter.ts', st: 'M' }, { n: 'src/payment/gateway/wechat-adapter.ts', st: 'M' }] },
    { sha: 'b901f33', msg: 'docs: 补充线上退款重放演练 Runbook', author: '明方鹏', time: '5 天前', ahead: false,
      files: [{ n: 'docs/runbook/refund-replay.md', st: 'A' }] },
    { sha: 'aa64d89', msg: 'refactor: 拆分订单分配器抽取金额整除余数兜底', author: '王大林', time: '6 天前', ahead: false,
      files: [{ n: 'src/order/split/allocator.ts', st: 'M' }] },
    { sha: '9120c0f', msg: 'chore: 更新 checkout 灰度路由超时阈值至 3500ms', author: '张景新', time: '1 周前', ahead: false,
      files: [{ n: 'config/routes/checkout.yml', st: 'M' }] }
  ];
  function gitLogOf(s) {
    if (state.gitStress) return STRESS_LOGS;
    return GIT_LOGS[s && s.originProject] || [];
  }
  function changesOf(s) {
    if (state.gitStress && s) return STRESS_CHANGES;
    return ((s && s.files) || []).filter(function (f) { return !!f.st; });
  }
  function gitAheadCount(logs) {
    return (logs || []).filter(function (c) { return !!c.ahead; }).length;
  }
  function buildTree(files) {
    var root = { children: [], files: [] };
    files.forEach(function (f) {
      var parts = f.n.split('/');
      var node = root, acc = '';
      for (var i = 0; i < parts.length - 1; i++) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        var next = null;
        for (var j = 0; j < node.children.length; j++) {
          if (node.children[j].path === acc) { next = node.children[j]; break; }
        }
        if (!next) { next = { name: parts[i], path: acc, children: [], files: [] }; node.children.push(next); }
        node = next;
      }
      node.files.push({ name: parts[parts.length - 1], path: f.n, file: f });
    });
    return root;
  }
  function compressTreeNode(node) {
    node.children = node.children.map(function (c) {
      var cur = c;
      while (cur.children.length === 1 && cur.files.length === 0) {
        var only = cur.children[0];
        cur = { name: cur.name + '/' + only.name, path: only.path, children: only.children, files: only.files };
      }
      return compressTreeNode(cur);
    });
    var paths = node.files.map(function (f) { return f.path; });
    node.children.forEach(function (c) { paths = paths.concat(c.allPaths || []); });
    node.allPaths = paths;
    return node;
  }
  function flattenTree(node, depth, out, openMap) {
    var map = openMap || state.treeOpen;
    node.children.forEach(function (c) {
      var open = map[c.path] !== false;
      out.push({ kind: 'dir', name: c.name, path: c.path, depth: depth, open: open, allPaths: c.allPaths || [] });
      if (open) flattenTree(c, depth + 1, out, map);
    });
    node.files.forEach(function (leaf) {
      out.push({ kind: 'file', name: leaf.name, path: leaf.path, depth: depth, file: leaf.file });
    });
    return out;
  }

  function openFile(path, diff, replaceActive) {
    if (!state.preview) state.preview = { tabs: [], active: path };
    if (replaceActive && state.preview.active) {
      var curIdx = state.preview.tabs.indexOf(state.preview.active);
      var existingIdx = state.preview.tabs.indexOf(path);
      if (existingIdx >= 0) {
        if (curIdx >= 0 && curIdx !== existingIdx) state.preview.tabs.splice(curIdx, 1);
      } else if (curIdx >= 0) {
        state.preview.tabs[curIdx] = path;
      } else {
        state.preview.tabs.push(path);
      }
    } else if (state.preview.tabs.indexOf(path) < 0) {
      state.preview.tabs.push(path);
    }
    state.preview.active = path;
    state.ptab = diff ? 'diff' : 'code';
    render();
  }
  function closeFile(path) {
    if (!state.preview) return;
    var i = state.preview.tabs.indexOf(path);
    if (i >= 0) state.preview.tabs.splice(i, 1);
    if (!state.preview.tabs.length) { state.preview = null; state.pvMax = false; }
    else if (state.preview.tabs.indexOf(state.preview.active) < 0) {
      state.preview.active = state.preview.tabs[Math.max(0, i - 1)];
    }
    render();
  }

  function filePaneHtml() {
    var pv = state.preview;
    var path = pv.active;
    var data = CODE[path] || null;
    var st = (data && data.st) || stOf(path);
    var lines = state.ptab === 'diff'
      ? ((data && data.diff) || defaultDiff(path))
      : ((data && data.code) || defaultCode(path));
    var body = lines.map(function (line, i) {
      var head = line.charAt(0);
      var cls = '';
      if (state.ptab === 'diff') {
        if (line.indexOf('@@') === 0) cls = 'hunk';
        else if (head === '+') cls = 'add';
        else if (head === '-') cls = 'del';
      }
      return '<span class="ln">' + (i + 1) + '</span><span class="' + cls + '">' + esc(line) + '</span>';
    }).join('\n');

    var tabs = pv.tabs.map(function (t) {
      var on = t === path;
      return '<div class="fp-tab-wrap' + (on ? ' is-active' : '') + '" role="presentation">' +
        '<button type="button" role="tab" class="fp-tab' + (on ? ' is-active' : '') + '" aria-selected="' + (on ? 'true' : 'false') + '"' +
          ' data-act="tab-file" data-file="' + esc(t) + '" data-focus="tab-file-' + esc(t) + '" title="' + esc(t) + '">' + icon('file', 12) +
          '<span class="t-mono">' + esc(baseName(t)) + '</span></button>' +
        '<button type="button" class="fp-tab-x" data-act="tab-close" data-file="' + esc(t) + '" aria-label="关闭 ' + esc(baseName(t)) + '" title="关闭">' + icon('x', 11) + '</button>' +
      '</div>';
    }).join('');

    var curChanges = changesOf(curSession());
    var cIdx = -1;
    for (var ci = 0; ci < curChanges.length; ci++) { if (curChanges[ci].n === path) { cIdx = ci; break; } }
    var stepper = curChanges.length > 1 && cIdx >= 0
      ? '<div class="fp-step-group" role="group" aria-label="变更文件步进">' +
          '<button type="button" class="fp-step-btn" data-act="diff-step" data-dir="-1" data-focus="diff-step-prev" aria-label="上一个变更文件" title="上一个变更文件">' + icon('chev-left', 13) + '</button>' +
          '<span class="fp-step-count">' + (cIdx + 1) + '/' + curChanges.length + '</span>' +
          '<button type="button" class="fp-step-btn" data-act="diff-step" data-dir="1" data-focus="diff-step-next" aria-label="下一个变更文件" title="下一个变更文件">' + icon('chev-right', 13) + '</button>' +
        '</div>'
      : '';

    return '<section class="filepane" aria-label="文件预览">' +
      '<div class="filepane-head">' +
        '<button type="button" class="icon-btn fp-back" data-act="tab-chat" aria-label="返回对话" title="返回对话">' + icon('back', 15) + '</button>' +
        '<div class="fp-tabs" role="tablist" aria-label="打开的文件">' + tabs + '</div>' +
        '<div class="fp-tools">' +
          '<div class="seg" role="tablist" aria-label="预览方式">' +
            '<button type="button" role="tab" class="' + (state.ptab === 'code' ? 'is-active' : '') + '" data-act="ptab" data-tab="code" data-focus="ptab-code" aria-selected="' + (state.ptab === 'code') + '">代码</button>' +
            '<button type="button" role="tab" class="' + (state.ptab === 'diff' ? 'is-active' : '') + '" data-act="ptab" data-tab="diff" data-focus="ptab-diff" aria-selected="' + (state.ptab === 'diff') + '">Diff</button>' +
          '</div>' +
          '<button type="button" class="icon-btn' + (state.pvMax ? ' is-on' : '') + '" data-act="pv-max" data-focus="pv-max" aria-label="' + (state.pvMax ? '还原分屏' : '放大预览') + '" title="' + (state.pvMax ? '还原分屏' : '放大预览') + '">' +
            icon(state.pvMax ? 'minimize' : 'maximize', 15) + '</button>' +
          '<button type="button" class="icon-btn" data-act="tab-chat" aria-label="关闭预览" title="关闭预览 (Esc)">' + icon('x', 15) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="fp-meta">' +
        '<span class="fp-full" title="' + esc(path) + '">' + esc(path) + '</span>' +
        '<span style="flex:1 1 0"></span>' +
        '<span class="fp-info">' + esc(langOf(path)) + '</span>' +
        '<span class="fp-info">' + lines.length + ' 行</span>' +
        '<span class="f-badge ' + stClass(st) + '">' + st + '</span>' +
        stepper +
      '</div>' +
      '<div class="filepane-body"><pre class="code">' + body + '</pre></div>' +
    '</section>';
  }

  /* ═══════════ 渲染:两层侧栏 = 固定图标栏 + 内容面板 ═══════════ */
  var PANE_LABEL = { sessions: '个人会话', inbox: '收件箱', board: '看板', tsessions: '团队会话', knowledge: '知识' };
  /* 每个团队固定一个色点颜色;无团队不显示 */
  var WS_DOT = ['#7c5cfc', '#0284c7', '#d97706', '#059669', '#dc2626', '#db2777'];
  function wsDot(wsId, left) {
    var idx = -1;
    WORKSPACES.forEach(function (w, i) { if (w.id === wsId) idx = i; });
    if (idx < 0) return '';
    if (left) return '<span class="team-dot left" title="已离开该团队"></span>';
    return '<span class="team-dot" style="--td:' + WS_DOT[idx % WS_DOT.length] + '" title="团队上下文：' + esc(wsById(wsId).name) + '"></span>';
  }
  function sessDot(s) {
    if (!s.team) return '';
    return wsDot(s.team, !teamRole(s.team, ME));
  }
  function pendingApprovals() {
    var out = [];
    mySessions().forEach(function (s) {
      (s.msgs || []).forEach(function (m) {
        if (m.w === 'approval' && m.state !== 'resolved' && !state.approvalDecisions[m.id]) out.push({ s: s, m: m });
      });
    });
    return out;
  }
  function peerUpdates() {
    var out = [];
    state.projects.forEach(function (p) {
      peersOf(p.id).forEach(function (pe) { if (pe.sync === 'updated' && !pe.archived) out.push(pe); });
    });
    return out;
  }


  /* 本机 Agent 权限审批留在原会话，不进跨人 Inbox */
  function sessionNeedsApproval(s) {
    return !!((s && s.msgs) || []).some(function (m) {
      return m.w === 'approval' && m.state !== 'resolved' && !state.approvalDecisions[m.id];
    });
  }

  /* ═══════════ Inbox: 只收口跨人异步拍板事项（任务指派 / 知识审核 / 系统地图 / 成员角色） ═══════════ */
  var REQ_TYPE = { task: '任务指派', prop: '知识审核', map: '系统地图', join: '加入团队', role: '角色变更' };
  var REQ_STATUS = { pending: '待处理', approved: '已同意', rejected: '已拒绝' };
  function propWs(p) { return p.ws || 'ws-base'; }
  function reqTitle(r) { return r.kind === 'join' ? '申请加入 ' + wsById(r.ws).name : '申请成为' + r.role; }
  function inboxItems() {
    var todo = [], sent = [];
    state.tasks.forEach(function (t) {
      var pj = projById(t.proj);
      if (!projectAccess(pj)) return;
      var src = (t.src === 'session' ? '对话 @ 派发' : '看板派发') + ' · ' + pj.name;
      if (t.to === ME && t.status === 'open') todo.push({ key: 'task:' + t.id, type: 'task', ref: t, ws: pj.ws, title: t.title, who: t.from, src: src, time: t.time });
      else if (t.from === ME && t.to !== ME) sent.push({ key: 'task:' + t.id, type: 'task', ref: t, ws: pj.ws, title: t.title, who: t.to, src: src, time: t.time, st: STATUS_TEXT[t.status] });
    });
    state.proposals.forEach(function (p) {
      var ws = propWs(p);
      if (!teamRole(ws, ME) || p.status === 'published') return;
      var it = { key: 'prop:' + p.id, type: p.kind === 'map' ? 'map' : 'prop', ref: p, ws: ws, title: kTitle(p), who: p.author,
        src: (p.kind === 'map' ? '系统地图提议' : '沉淀为团队知识') + ' · ' + LEVEL_TEXT[p.level || 'exp'], time: p.time };
      if (p.status === 'pending' && isAdmin(ws)) todo.push(it);
      if (p.author === ME) sent.push(Object.assign({}, it, { st: p.status === 'rejected' ? '已退回' : '待审核' }));
    });
    state.requests.forEach(function (r) {
      var it = { key: 'req:' + r.id, type: r.kind, ref: r, ws: r.ws, title: reqTitle(r), who: r.from, src: wsById(r.ws).name, time: r.time };
      if (r.status === 'pending' && isAdmin(r.ws) && r.from !== ME) todo.push(it);
      if (r.from === ME) sent.push(Object.assign({}, it, { st: REQ_STATUS[r.status] }));
    });
    return { todo: todo, sent: sent };
  }
  function inboxCount() { return inboxItems().todo.length; }
  function inboxTypeOk(it, f) {
    f = f || state.inboxType;
    if (f === 'all') return true;
    if (f === 'know') return it.type === 'prop' || it.type === 'map';
    if (f === 'member') return it.type === 'join' || it.type === 'role';
    return it.type === f;
  }

  function collapseBtn() {
    return '<button type="button" class="icon-btn side-collapse-btn" data-act="side-toggle" aria-label="收起面板" title="收起面板">' + icon('panel-left', 15) + '</button>';
  }
  function paneHead(inner) {
    return '<div class="pane-head">' + inner + '<span class="pane-spacer"></span>' + collapseBtn() + '</div>';
  }
  function wsSwitchHtml(btnId) {
    var ws = curWs();
    return '<button type="button" class="switch-btn ws-switch" id="' + btnId + '" data-act="ws-menu" aria-haspopup="menu" aria-expanded="false" title="' + esc(ws.name) + '">' +
      '<span class="switch-txt"><span class="switch-name od-truncate">' + esc(ws.name) + '</span>' +
      '<span class="switch-sub"><span class="od-truncate">' + esc(teamRole(ws.id, ME) || '成员') + ' · ' + ws.members.length + ' 人</span></span></span>' +
      '<span class="chev">' + icon('chev', 13) + '</span></button>';
  }
  var NO_TEAM_HINT = '加入或创建团队后，这里会显示团队的审批、看板、协作会话和知识库。你的个人会话和本机 Agent 不受影响。';

  function sessRow(s) {
    var active = !state.cross && s.id === state.session && state.view === 'chat';
    var landing = state.handshake && state.handshake.id === s.id && (Date.now() - state.handshake.at < 700);
    var needAppr = sessionNeedsApproval(s);
    return '<button type="button" class="sess-item ' + (active ? 'is-active' : '') + (landing ? ' is-landing' : '') + '" data-act="session" data-id="' + s.id + '" data-focus="sess-' + s.id + '"' +
      (active ? ' aria-current="true"' : '') + '>' +
      '<span class="sr-top">' +
        (s.running ? '<span class="sess-run" title="运行中"></span>' : '') +
        '<span class="sess-title">' + esc(s.title) + '</span>' +
        (needAppr ? '<span class="sess-appr-tag" title="本机 Agent 权限待你批准">待批准</span>' : '') +
        (s.unread ? '<span class="sess-unread" title="有未读回复"></span>' : '') +
      '</span>' +
      '<span class="sess-meta">' + sessDot(s) +
        (s.shareProject ? '<span class="sess-me-tag">我</span>' : '') +
        '<span class="line">' + esc(s.time) + '</span>' +
        ((s.extraDirs && s.extraDirs.length) ? '<span class="c4-dir-count" title="' + s.extraDirs.length + ' 个附加目录">+' + s.extraDirs.length + '</span>' : '') +
      '</span></button>';
  }
  function privateSessions() { return mySessions().filter(function (s) { return !s.shareProject; }); }
  function peerRow(pe) {
    var on = state.cross && state.cross.id === pe.id;
    return '<button type="button" class="cp-row' + (on ? ' is-active' : '') + '" data-act="pop-open" data-owner="' + pe.owner + '" data-id="' + pe.id + '" data-focus="peer-' + pe.id + '"' + (on ? ' aria-current="true"' : '') + '>' +
      '<span class="cp-top">' + av(pe.owner, 18) + '<span class="cp-title" title="' + esc(pe.title) + '">' + esc(pe.title) + '</span>' +
        (pe.sync === 'updated' ? '<span class="unsync-dot" title="有更新"></span>' : '') + '</span>' +
      '<span class="cp-meta"><span class="cp-owner">' + esc(PEOPLE[pe.owner].name) + '</span><span>·</span><span class="cp-time">' + esc(pe.time) + '</span></span>' +
      '</button>';
  }


  /* ═══════════ 方案 B 侧栏：单层纵向 264px，严格区分个人与团队 ═══════════ */
  function renderSidebar() {
    var bh = $('#backHomeBtn');
    var backLabel = state.cross
      ? ((state.returnTo && state.returnTo.label) || '返回会话')
      : ((state.returnTo && state.view === 'inbox') ? state.returnTo.label : '');
    var showBack = !!state.cross || !!(state.returnTo && state.view === 'inbox');
    put(bh, icon('back', 16) + '<span style="font-size:var(--text-base);margin-left:4px">' + esc(backLabel || '返回') + '</span>');
    bh.hidden = !showBack;
    bh.style.width = showBack ? 'auto' : '';
    bh.style.padding = showBack ? '0 10px' : '';

    var sb = $('#sidebar');
    var prevScroll = sb.querySelector('.sb-scroll') ? sb.querySelector('.sb-scroll').scrollTop : 0;
    captureSegs(sb);

    var team = state.space === 'team';
    var hasTeam = !!teamRole(state.ws, ME);
    var inboxN = hasTeam ? inboxCount() : 0;
    var peerUpdN = hasTeam ? peerUpdates().length : 0;
    var roleText = hasTeam ? teamRole(state.ws, ME) : '未加入团队';
    var hasMemConflict = MEM.personal.some(function (m) { return !!m.conflict; });

    var topRow = '<div class="sb-top">' +
      '<div class="space-sw-h" data-seg-key="space-sw-h" role="tablist" aria-label="切换空间">' +
        '<button type="button" role="tab" class="' + (!team ? 'is-on' : '') + '" data-act="space" data-id="personal" data-focus="space-personal" aria-selected="' + (!team) + '">' +
          icon('chat', 14) + '<span>个人</span></button>' +
        '<button type="button" role="tab" class="' + (team ? 'is-on' : '') + '" data-act="space" data-id="team" data-focus="space-team" aria-selected="' + team + '">' +
          icon('users', 14) + '<span>团队</span>' +
          (peerUpdN ? '<span class="sp-dot" title="队友会话有更新"></span>' : '') +
        '</button>' +
      '</div>' +
      collapseBtn() +
      '<button type="button" class="icon-btn sb-close-btn" data-act="drawer-close" aria-label="关闭侧栏" title="关闭侧栏">' + icon('x', 16) + '</button>' +
    '</div>';

    var inboxOn = state.view === 'inbox' && !state.cross;
    var ticked = state.prevInboxN !== null && state.prevInboxN !== inboxN;
    state.prevInboxN = inboxN;
    var inboxRow = hasTeam
      ? '<div class="sb-inbox-wrap">' +
          '<button type="button" class="nav-item' + (inboxOn ? ' is-active' : '') + '" data-act="inbox-go" data-id="todo" data-focus="nav-inbox"' + (inboxOn ? ' aria-current="page"' : '') + '>' +
            icon('check', 15) + '<span class="nav-label">Inbox · 待办与审批</span>' +
            (inboxN ? '<span class="nav-count is-strong' + (ticked ? ' is-ticking' : '') + '">' + inboxN + '</span>' : '') +
          '</button></div><div class="side-divider"></div>'
      : '<div class="side-divider"></div>';

    var midHtml = '';
    if (!team) {
      var filterName = state.sessFilter === 'all' ? '全部' : (state.sessFilter === 'none' ? '无团队' : wsById(state.sessFilter).name);
      var list = privateSessions().filter(function (s) {
        if (state.sessFilter === 'all') return true;
        if (state.sessFilter === 'none') return !s.team;
        return s.team === state.sessFilter;
      });
      var groups = [];
      list.forEach(function (s) {
        var d = s.mainDir || '未设置目录';
        var g = groups.filter(function (x) { return x.dir === d; })[0];
        if (!g) { g = { dir: d, items: [] }; groups.push(g); }
        g.items.push(s);
      });
      var sessListHtml = !list.length
        ? '<p class="side-empty">' + (state.sessFilter === 'all' ? '还没有个人会话。<br>点上面的「新建个人会话」开始。' : '这个筛选下没有会话。') + '</p>'
        : groups.map(function (g) {
            var open = state.dirOpen[g.dir] !== false;
            return '<div class="sb-grp">' +
              '<button type="button" class="grp-head' + (open ? '' : ' is-closed') + '" data-act="sess-dir" data-dir="' + esc(g.dir) + '" aria-expanded="' + open + '" title="' + esc(g.dir) + '" data-focus="dir-' + esc(g.dir) + '">' +
                '<span class="chev">' + icon('chev', 11) + '</span><span class="d">' + esc(baseName(g.dir) || g.dir) + '</span><span class="n">' + g.items.length + '</span></button>' +
              '<div class="grp-collapse" data-grp="' + esc(g.dir) + '" data-open="' + (open ? '1' : '0') + '"' + (open ? '' : ' aria-hidden="true"') + '><div class="grp-collapse-inner">' + g.items.map(sessRow).join('') + '</div></div>' +
            '</div>';
          }).join('');
      var shared = mySessions().filter(function (s) { return s.shareProject; }).length;
      midHtml = '<div class="sb-cta-row">' +
          '<button type="button" class="btn btn-primary" data-act="new-session" data-focus="new-session">' + icon('pen', 14) + '<span>新建个人会话</span></button>' +
          '<button type="button" class="icon-btn sb-search-btn" data-act="palette" aria-label="全局搜索" title="全局搜索 (⌘K)">' + icon('search', 15) + '</button>' +
        '</div>' +
        '<div class="sb-sec-head"><span>个人会话</span>' +
          '<button type="button" class="sb-filter-btn" data-act="sess-menu" aria-haspopup="menu" aria-expanded="false" data-focus="sess-menu">' +
            esc(filterName) + icon('chev', 11) + '</button></div>' +
        '<div class="sb-scroll">' + sessListHtml + (shared ? '<p class="pane-foot">另有 ' + shared + ' 个会话已发布，在「团队」空间里。</p>' : '') + '</div>';
    } else {
      var ws = curWs();
      if (!ws.id) {
        midHtml = '<div class="sb-scroll"><p class="side-empty">' + NO_TEAM_HINT + '</p>' +
          '<div class="pane-cta" style="display:grid;gap:6px">' +
            journeyBtn('perspective-set', '切换到 张景新（管理员）', ADMIN, true) +
            journeyBtn('space', '回到个人空间', 'personal', false) +
          '</div></div>';
      } else {
        var boardOn = state.view === 'board' && !state.cross;
        var knowOn = state.view === 'knowledge' && !state.cross;
        var pubKnowN = publishedKnowledge().length;
        var pendN = pendingProposals().length;
        var collabHtml = wsProjects().map(function (p) {
          var open = (p.id in state.collabOpen) ? state.collabOpen[p.id] : p.id === state.proj;
          var mine = mySessions().filter(function (s) { return s.shareProject === p.id; });
          var peers = peersOf(p.id);
          var inner = mine.map(sessRow).join('') + peers.map(peerRow).join('') || '<p class="cp-empty">暂无已发布会话</p>';
          return '<div class="cp-proj">' +
            '<div class="cp-proj-row">' +
              '<button type="button" class="grp-head cp-head' + (open ? '' : ' is-closed') + '" data-act="collab-proj" data-id="' + p.id + '" aria-expanded="' + open + '" data-focus="cp-' + p.id + '">' +
                '<span class="chev">' + icon('chev', 11) + '</span><span class="d">' + esc(p.name) + '</span><span class="n">' + (mine.length + peers.length) + '</span></button>' +
              '<button type="button" class="icon-btn cp-gear" data-act="collab-nav" data-proj="' + p.id + '" data-view="project" aria-label="' + esc(p.name) + ' 资料与成员" title="Project 资料与成员">' + icon('sliders', 13) + '</button>' +
            '</div>' +
            '<div class="grp-collapse" data-grp="cp-' + p.id + '" data-open="' + (open ? '1' : '0') + '"' + (open ? '' : ' aria-hidden="true"') + '><div class="grp-collapse-inner cp-body">' + inner + '</div></div>' +
          '</div>';
        }).join('');

        midHtml = '<div class="sb-ws-row">' + wsSwitchHtml('teamWsBtn') +
            '<button type="button" class="btn btn-secondary btn-roles" data-act="roles" title="Workspace 成员与角色管理">成员</button>' +
            '<button type="button" class="icon-btn sb-search-btn" data-act="palette" aria-label="全局搜索" title="全局搜索 (⌘K)">' + icon('search', 15) + '</button>' +
          '</div>' +
          '<nav class="sb-nav-group" aria-label="团队功能">' +
            '<button type="button" class="nav-item' + (boardOn ? ' is-active' : '') + '" data-act="nav" data-view="board" data-focus="nav-board"' + (boardOn ? ' aria-current="page"' : '') + '>' +
              icon('board', 15) + '<span class="nav-label">看板</span></button>' +
            '<button type="button" class="nav-item' + (knowOn ? ' is-active' : '') + '" data-act="nav" data-view="knowledge" data-focus="nav-knowledge"' + (knowOn ? ' aria-current="page"' : '') + '>' +
              icon('book', 15) + '<span class="nav-label">团队知识</span>' +
              '<span class="nav-count">' + pubKnowN + (pendN ? ' · ' + pendN + '审' : '') + '</span></button>' +
          '</nav>' +
          '<div class="side-divider"></div>' +
          '<div class="sb-sec-head"><span>协作会话</span>' +
            '<button type="button" class="icon-btn sb-add-btn" data-act="new-project-session" data-focus="new-project-session" aria-label="新建 Project 会话" title="新建 Project 会话">' + icon('plus', 14) + '</button></div>' +
          '<div class="sb-scroll">' + collabHtml +
            '<button type="button" class="nav-item" style="margin-top:4px" data-act="new-project" data-focus="new-project">' + icon('plus', 14) + '<span class="nav-label">新建 Project</span></button>' +
          '</div>';
      }
    }

    var footHtml = '<div class="sb-foot">' +
      '<button type="button" class="nav-item" data-act="ctx-memory">' + icon('brain', 15) + '<span class="nav-label">本机记忆 (team / personal)</span>' +
        (hasMemConflict ? '<span class="sb-mem-dot" title="personal.md 有 1 处与系统地图不一致"></span>' : '') + '</button>' +
      '<div class="sb-user">' + av(ME, 26) +
        '<button type="button" class="c4-account" data-act="perspective" title="点击切换演示视角">' +
          '<span class="u-name od-truncate">' + esc(PEOPLE[ME].name) + '</span>' +
          '<span class="u-role od-truncate">' + esc(roleText) + ' · 切换视角</span></button>' +
        '<button type="button" class="icon-btn" data-act="open-settings" data-focus="open-settings" aria-label="系统设置" title="系统设置">' + icon('gear', 15) + '</button>' +
      '</div></div>';

    put(sb, topRow + inboxRow + midHtml + footHtml);
    var sc = sb.querySelector('.sb-scroll');
    if (sc && prevScroll) sc.scrollTop = prevScroll;
    animateSegs(sb);
  }


  /* ═══════════ 渲染:顶栏 ═══════════ */
  var VIEW_TITLE = {
    board: '看板',
    inbox: 'Inbox · 待办与审批',
    knowledge: '团队知识库',
    project: 'Project 资料与成员'
  };

  function topbarTitleHtml() {
    var proj = curProj();
    var peer = curPeer();
    var crumb = !state.side
      ? '<span class="tb-crumb"><span class="tb-crumb-name">' + esc(state.space === 'team' ? (proj.id ? proj.name : curWs().name) : '个人空间') + '</span><span class="tb-crumb-sep">/</span></span>'
      : '';

    if (peer) {
      var owner = PEOPLE[peer.owner];
      var synced = !!peerIsSynced(peer);
      var stateTxt = synced ? '已同步 · 只读' : (SYNC_TEXT[peer.sync] + ' · 只读');
      return '<span class="tb-peer">' + av(peer.owner, 20) + '<span class="tb-peer-name">' + esc(owner.name) + '</span></span>' +
        '<span class="tb-dot-sep" aria-hidden="true">·</span>' +
        '<span class="tb-name" title="' + esc(peer.title) + '">' + esc(peer.title) + '</span>' +
        '<span class="tb-state ' + (synced ? 'ro' : 'sync') + '">' +
          (synced ? '' : '<span class="d" aria-hidden="true"></span>') + stateTxt + '</span>';
    }

    if (state.view === 'chat') {
      var s = curSession();
      if (!s) return crumb + '<span class="tb-name">' + esc(state.space === 'team' ? proj.name : '个人工作台') + '</span>' +
        '<span class="tb-count">还没有本机会话</span>';
      var dirName = baseName(String(s.mainDir || '').replace(/\/+$/, '')) || 'workspace';
      var out = crumb +
        '<span class="tb-name" title="' + esc(s.title) + '">' + esc(s.title) + '</span>' +
        '<button type="button" class="tb-dir" id="tbDirBtn" data-act="dir-menu" data-focus="dir-menu" aria-haspopup="dialog"' +
          ' title="主目录：' + esc(s.mainDir) + '">' +
          icon('folder', 12) + '<span class="d">' + esc(dirName) + '</span>' +
          (s.extraDirs.length ? '<span class="c4-dir-count">+' + s.extraDirs.length + ' 附加目录</span>' : '') +
          '<span class="chev" aria-hidden="true">' + icon('chev', 11) + '</span></button>';
      if (s.running) out += '<span class="tb-state running"><span class="d" aria-hidden="true"></span>运行中</span>';
      return out;
    }

    var counts = {
      board: boardTasks().length + ' 个任务 · ' + (state.boardProj === 'all' ? curWs().name + ' · 全部 Project' : (projById(state.boardProj) || proj).name),
      inbox: inboxCount() + ' 项待我处理',
      knowledge: knowledgeForScope().length + ' 条已发布',
      project: proj.members.length + ' 位成员'
    };
    return crumb + '<span class="tb-name">' + esc(VIEW_TITLE[state.view] || proj.name) + '</span>' +
      '<span class="tb-count">' + esc(counts[state.view] || '') + '</span>';
  }

  function renderTopbar() {
    var proj = curProj(), peer = curPeer();
    var db = $('#drawerBtn'); if (db) put(db, icon('menu', 18));
    var tg = $('#sideToggle');
    if (tg) {
      put(tg, icon('panel-left', 16));
      tg.setAttribute('aria-pressed', state.side ? 'true' : 'false');
      tg.setAttribute('aria-label', state.side ? '收起左栏' : '展开并固定左栏');
      tg.title = state.side ? '收起左栏' : '展开并固定左栏';
      tg.classList.toggle('is-on', !state.side);
    }
    put($('#tbTitle'), topbarTitleHtml());

    /* 仅在团队空间且有可用 Project 时显示协作成员头像条，个人空间完全隐去 */
    var mates = teammates();
    var anyUpd = mates.some(hasUpdate);
    var showCollab = state.space === 'team' && !!proj.id && !!teamRole(state.ws, ME) && (state.view === 'chat' || state.view === 'board' || state.view === 'project' || !!peer);
    var wasCollab = !!($('#tbCollab') && $('#tbCollab').children.length);
    put($('#tbCollab'), !showCollab ? '' :
      '<button type="button" class="collab-btn" data-act="member-peek" data-owner="all" aria-haspopup="dialog" aria-expanded="' + (!$('#popover').hidden ? 'true' : 'false') + '"' +
        ' title="协作成员与队友会话" aria-label="协作成员 ' + proj.members.length + ' 人' + (anyUpd ? ' · 有更新' : '') + '">' +
        '<span class="av-stack">' + mates.slice(0, 3).map(function (m) {
          return '<span style="position:relative;display:inline-flex">' + av(m, 22) +
            (hasUpdate(m) ? '<span class="av-dot" aria-hidden="true"></span>' : '') + '</span>';
        }).join('') + '</span>' +
        '<span class="collab-count">' + proj.members.length + '</span>' +
        (anyUpd ? '<span class="collab-dot" aria-hidden="true"></span>' : '') +
        '<span class="collab-chev" aria-hidden="true">' + icon('chev', 12) + '</span>' +
      '</button>');
    if (showCollab && !wasCollab && state.handshake && state.handshake.dir === 'to-team') {
      $('#tbCollab').classList.add('is-arriving');
    } else if ($('#tbCollab')) {
      $('#tbCollab').classList.remove('is-arriving');
    }

    var roRail = !!peer || state.view !== 'chat';
    var railTitle = roRail ? (peer ? '跨机只读会话不连接对方本地文件' : '本机文件栏只在会话中显示') : (state.rail ? '收起本机文件栏' : '展开本机文件栏');
    var cmpLink = '';
    put($('#tbRight'),
      cmpLink +
      '<button type="button" class="icon-btn" data-act="theme" aria-label="切换浅色/深色" title="切换浅色/深色">' + icon(state.theme === 'dark' ? 'sun' : 'moon', 16) + '</button>' +
      '<button type="button" class="icon-btn ' + (state.rail && !roRail ? 'is-on' : '') + '" data-act="rail" aria-label="' + railTitle + '" title="' + railTitle + '"' + (roRail ? ' disabled' : '') + '>' + icon('panel', 16) + '</button>');
  }

  /* ═══════════ 渲染:舞台 ═══════════ */
  function renderStage() {
    var stage = $('#stage');
    captureSegs(stage);
    var prevCrossKey = state.cross ? state.cross.id : null;
    var routeChanged = (state.prevView !== null && (state.prevView !== state.view || state.prevCross !== prevCrossKey));
    state.prevView = state.view; state.prevCross = prevCrossKey;
    var prevStageScroll = !routeChanged ? stage.scrollTop : 0;
    var prevChatScroll = (!state.shouldScrollEnd && $('#chatScroll')) ? $('#chatScroll').scrollTop : null;
    var prevDrawer = !!$('.t-drawer', stage);
    stage.classList.toggle('fixed', (state.view === 'chat' && !state.cross) || !!state.cross);
    if (state.cross) { put(stage, viewPeer()); }
    else if (state.view === 'chat') { put(stage, viewChat()); }
    else if (state.view === 'board') { put(stage, viewBoard()); }
    else if (state.view === 'inbox') { put(stage, viewInbox()); }
    else if (state.view === 'knowledge') { put(stage, viewKnowledge()); }
    else if (state.view === 'project') { put(stage, viewProject()); }
    if (prevDrawer && $('.t-drawer', stage)) $('.t-drawer', stage).classList.add('is-open-static');
    stage.classList.remove('is-entering');
    if (routeChanged && state.view !== 'chat') { void stage.offsetWidth; stage.classList.add('is-entering'); }
    if (!routeChanged && state.view !== 'chat' && prevStageScroll) stage.scrollTop = prevStageScroll;
    var cs = $('#chatScroll');
    if (state.shouldScrollEnd) {
      state.shouldScrollEnd = false;
      var pendAppr = cs ? $('.tl-appr.is-pending', cs) : null;
      if (pendAppr) pendAppr.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else scrollChatToEnd();
    } else if (prevChatScroll !== null && cs) {
      cs.scrollTop = prevChatScroll;
    }
    animateSegs(stage);
    if (cs && !cs._mmBound) {
      cs._mmBound = true;
      cs.addEventListener('scroll', syncMinimapActive, { passive: true });
    }
    syncMinimapActive();
  }

  var CODE_MAP = {};
  var MSG_TEXT_MAP = {};

  function tlPathHtml(val) {
    var s = String(val == null ? '' : val);
    var idx = s.lastIndexOf('/');
    if (idx > 0 && s.indexOf(' ') < 0) {
      return '<span class="tl-path-dir">' + esc(s.slice(0, idx + 1)) + '</span><span class="tl-path-base">' + esc(s.slice(idx + 1)) + '</span>';
    }
    return '<span class="tl-target-txt">' + esc(s) + '</span>';
  }

  /* 轻量语法高亮：单趟正则分词，全部文本先走 esc() 确保安全 */
  function highlightCode(code, lang) {
    var src = String(code == null ? '' : code);
    var l = String(lang || '').toLowerCase();
    if (l === 'diff') {
      return src.split('\n').map(function (line) {
        if (/^\+/.test(line)) return '<span class="tok-str">' + esc(line) + '</span>';
        if (/^-/.test(line)) return '<span class="tok-num">' + esc(line) + '</span>';
        if (/^@@/.test(line)) return '<span class="tok-kw">' + esc(line) + '</span>';
        return esc(line);
      }).join('\n');
    }
    var re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\[\s\S]|[^`])*`|'(?:\\.|[^'\n])*'|"(?:\\.|[^"\n])*")|\b(export|async|function|const|let|var|return|import|from|type|interface|if|else|await|try|catch|new|throw|switch|case|default|npx|run)\b|\b(true|false|null|undefined|\d+(?:\.\d+)?)\b|(--[A-Za-z0-9-]+)|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-z_$][A-Za-z0-9_$]*)(?=\s*\()/g;
    var out = '';
    var last = 0;
    src.replace(re, function (match, com, str, kw, num, flag, tp, fn, offset) {
      if (offset > last) out += esc(src.slice(last, offset));
      var cls = com ? 'tok-com' : (str ? 'tok-str' : (kw ? 'tok-kw' : (num ? 'tok-num' : (flag ? 'tok-flag' : (tp ? 'tok-type' : (fn ? 'tok-fn' : ''))))));
      out += cls ? '<span class="' + cls + '">' + esc(match) + '</span>' : esc(match);
      last = offset + match.length;
      return match;
    });
    if (last < src.length) out += esc(src.slice(last));
    return out;
  }

  function isHumanMsg(m) {
    return m && !({ 'sys-divider': 1, sys: 1, thinking: 1, workgroup: 1, tool: 1, subagent: 1, approval: 1, plan: 1, agent: 1, reference: 1 })[m.w];
  }

  /* 提取当前会话里的 Prompt 列表（供左侧 Prompt 导航条与滚动态追踪使用） */
  function extractPrompts(msgs) {
    var list = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!isHumanMsg(m)) continue;
      var ans = '';
      for (var j = i + 1; j < msgs.length; j++) {
        if (isHumanMsg(msgs[j])) break;
        if (msgs[j].w === 'agent') ans = tlAgentPlainText(msgs[j]).replace(/\s+/g, ' ').trim();
      }
      list.push({ pIdx: list.length, msgIdx: i, time: m.time || '', text: m.text || '', ans: ans });
    }
    return list;
  }

  /* 判断当前 thinking/workgroup/tool 之后同回合内是否已有完整 Agent 回复（有则自动收起） */
  function hasAgentDoneAfter(msgs, idx) {
    for (var j = idx + 1; j < msgs.length; j++) {
      var nm = msgs[j];
      if (isHumanMsg(nm)) return false;
      if (nm.w === 'agent' && nm.status !== 'stream' && nm.status !== 'cut') return true;
    }
    return false;
  }

  function tlMinimapHtml(msgs) {
    var prompts = extractPrompts(msgs);
    if (prompts.length < 2) return '';
    var cur = Math.max(0, Math.min(prompts.length - 1, state.activePromptIdx || 0));
    return '<aside class="tl-minimap" id="tlMinimap" aria-label="会话 Prompt 导航">' +
      '<button type="button" class="tl-mm-nav" data-act="prompt-prev" aria-label="上一条 Prompt" title="上一条 Prompt"' + (cur <= 0 ? ' disabled' : '') + '>' + icon('chev-up', 13) + '</button>' +
      '<div class="tl-mm-track" role="navigation" aria-label="Prompt 快速定位">' +
        prompts.map(function (p) {
          var on = p.pIdx === cur;
          return '<button type="button" class="tl-mm-item' + (on ? ' is-active' : '') + '" data-act="prompt-jump" data-pidx="' + p.pIdx + '" aria-label="跳转到 Prompt ' + (p.pIdx + 1) + ': ' + esc(p.text.slice(0, 28)) + '"' + (on ? ' aria-current="true"' : '') + '>' +
            '<span class="tl-mm-bar" aria-hidden="true"></span>' +
            '<span class="tl-mm-pop" aria-hidden="true">' +
              '<span class="tl-mm-pop-meta">Prompt ' + (p.pIdx + 1) + (p.time ? ' · ' + esc(p.time) : '') + '</span>' +
              '<span class="tl-mm-pop-u">' + esc(p.text) + '</span>' +
              (p.ans ? '<span class="tl-mm-pop-a">' + esc(p.ans) + '</span>' : '<span class="tl-mm-pop-a">处理中 / 等待审批…</span>') +
            '</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<button type="button" class="tl-mm-nav" data-act="prompt-next" aria-label="下一条 Prompt" title="下一条 Prompt"' + (cur >= prompts.length - 1 ? ' disabled' : '') + '>' + icon('chev', 13) + '</button>' +
    '</aside>';
  }

  function syncMinimapActive() {
    var sc = $('#chatScroll');
    var mm = $('#tlMinimap');
    if (!sc || !mm) return;
    var nodes = $$('[data-prompt-idx]', sc);
    if (!nodes.length) return;
    var scTop = sc.getBoundingClientRect().top + 96;
    var cur = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getBoundingClientRect().top <= scTop) cur = i;
    }
    state.activePromptIdx = cur;
    var items = $$('.tl-mm-item', mm);
    items.forEach(function (btn, idx) {
      var on = idx === cur;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
    var prevBtn = $('[data-act="prompt-prev"]', mm);
    var nextBtn = $('[data-act="prompt-next"]', mm);
    if (prevBtn) prevBtn.disabled = cur <= 0;
    if (nextBtn) nextBtn.disabled = cur >= items.length - 1;
  }

  function jumpToPrompt(pIdx) {
    var sc = $('#chatScroll');
    if (!sc) return;
    var target = sc.querySelector('[data-prompt-idx="' + pIdx + '"]');
    if (!target) return;
    state.activePromptIdx = pIdx;
    state.targetPromptIdx = pIdx;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $$('[data-prompt-idx].is-targeted', sc).forEach(function (el) { el.classList.remove('is-targeted'); });
    target.classList.add('is-targeted');
    syncMinimapActive();
    setTimeout(function () { if (target) target.classList.remove('is-targeted'); }, 1400);
  }

  function tlIdOf(m, idx, suffix) {
    return (state.cross ? 'p:' + state.cross.id : state.session) + ':' + idx + (suffix ? ':' + suffix : '');
  }
  function iconForTool(name) {
    var n = String(name || '').toLowerCase();
    if (/(read|open|cat|eye)/.test(n)) return 'eye';
    if (/(grep|search|find)/.test(n)) return 'search';
    if (/(edit|write|pen|patch)/.test(n)) return 'pen';
    if (/(branch|git|diff)/.test(n)) return 'git';
    return 'terminal';
  }
  function iconFor(ic) {
    return ({ eye: 'eye', search: 'search', pen: 'pen', terminal: 'terminal', git: 'git', play: 'play', file: 'file', brain: 'brain' })[ic] || 'terminal';
  }

  /* 行内富文本：反引号代码片 + @《知识》链接 */
  function tlText(text) {
    var s = esc(text == null ? '' : text);
    s = s.replace(/`([^`]+)`/g, '<code class="tl-inline">$1</code>');
    s = s.replace(/@《([^》]+)》\s?([vV][\d.]+)?/g, function (all, title, ver) {
      return '<button type="button" class="tl-chip is-know" data-act="know-chip" data-title="' + title + '" title="查看知识条目">@《' + title + '》' + (ver || '') + '</button>';
    });
    return s;
  }

  function tlDivider(m) {
    var pin = /^已固定引用/.test(m.label || '');
    return '<div class="tl-divider' + (pin ? ' is-pin' : '') + '">' +
      '<span class="tl-rule"></span>' +
      '<span class="tl-div-label">' + esc(m.label || m.text || '') + '</span>' +
      '<span class="tl-rule"></span></div>';
  }

  function tlUser(m, pIdx) {
    var p = PEOPLE[m.w] || PEOPLE[ME];
    var ctx = (m.ctx || []).map(function (c) {
      if (c.know) {
        return '<button type="button" class="tl-chip is-know" data-act="know-chip" data-title="' + esc(c.know) + '" title="查看知识条目">' +
          icon('book', 11) + esc(c.know) + (c.ver ? ' ' + esc(c.ver) : '') + '</button>';
      }
      if (c.file) {
        return '<button type="button" class="tl-chip" data-act="file-open" data-file="' + esc(c.file) + '" title="在右侧预览">' +
          icon('file', 11) + esc(c.t) + '</button>';
      }
      return '<span class="tl-chip">' + esc(c.t) + '</span>';
    }).join('');
    var pAttr = typeof pIdx === 'number' ? ' data-prompt-idx="' + pIdx + '"' : '';
    var tgtCls = state.targetPromptIdx === pIdx ? ' is-targeted' : '';
    return '<div class="tl tl-user' + tgtCls + '"' + pAttr + '>' +
      '<div class="tl-user-box">' +
        '<div class="tl-user-who"><span class="tl-name">' + esc(p.name) + '</span>' +
          '<span class="tl-meta">' + esc(m.time || p.role) + '</span></div>' +
        '<div class="tl-user-bubble"><div class="tl-text">' + tlText(m.text) + '</div></div>' +
        (ctx ? '<div class="tl-ctx">' + ctx + '</div>' : '') +
      '</div></div>';
  }

  function tlOpenState(tid, done) {
    if (tid in state.openTools) return !!state.openTools[tid];
    return !done;
  }

  function tlThinking(m, key, done) {
    var tid = 'th:' + key;
    var open = tlOpenState(tid, done);
    return '<div class="tl"><div class="tl-body">' +
      '<button type="button" class="tl-disc" data-act="toggle-tool" data-tid="' + esc(tid) + '" data-def-open="' + (!done ? '1' : '0') + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="tl-ic">' + icon('brain', 14) + '</span>' +
        '<span class="tl-disc-main"><span class="tl-disc-t">' + esc(m.label || '思考过程') + '</span>' +
          (m.dur ? '<span class="tl-disc-s">用时 ' + esc(m.dur) + (done ? ' · 可展开' : '') + '</span>' : '') + '</span>' +
        '<span class="tl-caret">' + icon('chev-right', 12) + '</span>' +
      '</button>' +
      '<div class="tl-collapse" data-tid-body="' + esc(tid) + '" data-open="' + (open ? '1' : '0') + '"' + (open ? '' : ' aria-hidden="true"') + '><div class="tl-collapse-inner tl-details">' + (m.body || []).map(function (t) { return '<p>' + tlText(t) + '</p>'; }).join('') + '</div></div>' +
      '</div></div>';
  }

  function tlBadgeClass(r) {
    if (r.tone === 'err') return 'is-err';
    if (r.tone === 'warn') return 'is-warn';
    if (r.tone === 'ok' || r.ok) return 'is-ok';
    return '';
  }

  function tlWorkRow(r, key) {
    var tid = 'wr:' + key;
    var open = !!state.openTools[tid];
    var expandable = !!(r.out || r.file);
    var errCls = r.tone === 'err' ? ' is-err' : '';
    var knowBtn = (r.knowledge && !state.cross)
      ? '<button type="button" class="btn btn-secondary btn-sm tl-know-btn" data-act="knowledge-snapshot" data-knowledge="' + esc(r.knowledge) + '" data-version="' + esc(r.version || '') + '" title="在团队知识库查看锁定版本">查看 ' + esc(r.version || '固定版本') + '</button>'
      : '';
    var actionsHtml = r.file
      ? '<div class="tl-out-actions">' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="file-open" data-file="' + esc(r.file) + '">' + icon('file', 12) + '打开文件</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="file-open" data-file="' + esc(r.file) + '" data-diff="1">' + icon('git', 12) + '查看 Diff</button>' +
        '</div>'
      : '';
    return '<div class="tl-wc"><div class="tl-wrow' + errCls + '">' +
      '<button type="button" class="tl-wbtn" data-act="toggle-tool" data-tid="' + esc(tid) + '" aria-expanded="' + (open ? 'true' : 'false') + '"' + (expandable ? '' : ' disabled') + '>' +
        '<span class="tl-wic">' + icon(iconFor(r.ic), 13) + '</span>' +
        '<span class="tl-verb">' + esc(r.verb) + '</span>' +
        '<span class="tl-target" title="' + esc(r.target) + '">' + tlPathHtml(r.target) + '</span>' +
        (r.badge ? '<span class="tl-badge ' + tlBadgeClass(r) + '">' + esc(r.badge) + '</span>' : '') +
        (expandable ? '<span class="tl-wchev">' + icon('chev-right', 11) + '</span>' : '') +
      '</button>' + knowBtn + '</div>' +
      (expandable ? '<div class="tl-collapse" data-tid-body="' + esc(tid) + '" data-open="' + (open ? '1' : '0') + '"' + (open ? '' : ' aria-hidden="true"') + '><div class="tl-collapse-inner"><div class="tl-out' + errCls + '">' +
        (r.out ? '<pre class="tl-out-pre">' + highlightCode(r.out, r.tone === 'err' ? 'bash' : 'ts') + '</pre>' : '') +
        actionsHtml + '</div></div></div>' : '') +
      '</div>';
  }

  function tlWorkgroup(m, key, done) {
    var tid = 'wg:' + key;
    var open = tlOpenState(tid, done);
    return '<div class="tl"><div class="tl-body">' +
      '<button type="button" class="tl-disc" data-act="toggle-tool" data-tid="' + esc(tid) + '" data-def-open="' + (!done ? '1' : '0') + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="tl-ic">' + icon('terminal', 14) + '</span>' +
        '<span class="tl-disc-main"><span class="tl-disc-t">' + esc(m.title) + '</span>' +
          (m.dur ? '<span class="tl-disc-s">用时 ' + esc(m.dur) + (done ? ' · 点此展开步骤' : '') + '</span>' : '') + '</span>' +
        '<span class="tl-caret">' + icon('chev-right', 12) + '</span>' +
      '</button>' +
      (m.summary ? '<div class="tl-collapse" data-tid-sum="' + esc(tid) + '" data-open="' + (!open ? '1' : '0') + '"' + (!open ? '' : ' aria-hidden="true"') + '><div class="tl-collapse-inner tl-details"><p>' + esc(m.summary) + '</p></div></div>' : '') +
      '<div class="tl-collapse" data-tid-body="' + esc(tid) + '" data-open="' + (open ? '1' : '0') + '"' + (open ? '' : ' aria-hidden="true"') + '><div class="tl-collapse-inner tl-rows">' + (m.rows || []).map(function (r, i) { return tlWorkRow(r, key + ':r' + i); }).join('') + '</div></div>' +
      '</div></div>';
  }

  function tlTool(m, key) {
    var row = {
      ic: guessIcFromTool(m.tool), verb: m.tool,
      target: m.detail, out: m.out, file: m.file, badge: m.badge, tone: m.tone
    };
    return '<div class="tl"><div class="tl-body">' +
      '<div class="tl-rows is-flat">' + tlWorkRow(row, key) + '</div>' +
      (m.knowledge && !state.cross ? '<div class="c4-bar">' + journeyBtn('knowledge-snapshot', '查看固定版本 · ' + m.detail, key, false, 'data-knowledge="' + esc(m.knowledge) + '" data-version="' + esc(m.version) + '"') + '</div>' : '') + '</div></div>';
  }
  function guessIcFromTool(name) {
    var n = String(name || '').toLowerCase();
    if (/(read|open|cat)/.test(n)) return 'eye';
    if (/(grep|search|find)/.test(n)) return 'search';
    if (/(edit|write|patch)/.test(n)) return 'pen';
    if (/(git|diff|branch)/.test(n)) return 'git';
    return 'terminal';
  }

  function tlSubagent(m, key) {
    var tid = 'sa:' + key;
    var open = !!state.openTools[tid];
    var live = m.state === 'running';
    return '<div class="tl"><div class="tl-body">' +
      '<div class="tl-sub' + (live ? ' is-live' : '') + '">' +
        '<div class="tl-sub-head">' +
          '<span class="tl-sub-ic">' + icon('agent', 13) + '</span>' +
          '<span class="tl-sub-name">' + esc(m.name) + '</span>' +
          (m.model ? '<span class="tl-sub-model">' + esc(m.model) + '</span>' : '') +
          '<span class="tl-sub-status' + (live ? ' is-live' : '') + '">' +
            (live ? '<span class="tl-live-dot" aria-hidden="true"></span>' : icon('check', 11)) +
            esc(m.statusText) + '</span>' +
        '</div>' +
        '<span class="tl-sub-meta" title="' + esc(m.meta || '') + '">' + esc(m.meta || '') + '</span>' +
        '<button type="button" class="tl-disc" data-act="toggle-tool" data-tid="' + esc(tid) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span class="tl-caret">' + icon('chev-right', 12) + '</span>' +
          '<span class="tl-disc-main"><span class="tl-disc-s">' + esc(m.goal) + '</span></span>' +
        '</button>' +
        '<div class="tl-collapse" data-tid-body="' + esc(tid) + '" data-open="' + (open ? '1' : '0') + '"' + (open ? '' : ' aria-hidden="true"') + '><div class="tl-collapse-inner tl-details">' +
          (m.rows && m.rows.length ? '<div class="tl-rows is-flat">' + m.rows.map(function (r, i) { return tlWorkRow(r, key + ':sr' + i); }).join('') + '</div>' : '') +
          (m.find ? '<p>' + tlText(m.find) + '</p>' : '') +
          (m.file ? '<div class="tl-plan-actions"><button type="button" class="btn btn-secondary btn-sm" data-act="file-open" data-file="' + esc(m.file) + '">' + icon('file', 12) + '打开结论文件</button></div>' : '') +
        '</div></div>' +
      '</div></div></div>';
  }

  function tlApproval(m, key) {
    var readonly = !!state.cross;
    var busy = !!(m.id && state.approvalBusy[m.id]);
    var dec = m.id ? state.approvalDecisions[m.id] : null;
    var pending = m.state !== 'resolved';
    var cls = pending ? (busy ? ' is-busy' : (!dec ? ' is-pending' : (dec === 'denied' ? ' is-denied' : ' is-allowed'))) : '';
    var stateText = m.state === 'resolved'
      ? (m.resolvedText || '已由你允许一次')
      : (busy ? '正在恢复本机执行…' : (dec ? ({ once: '已允许（本次执行）', always: '已允许（本会话始终放行）', denied: '已拒绝（已中止执行）' })[dec] : '等待你审批'));
    var actions = '';
    if (pending) {
      if (readonly) {
        actions = '<div class="tl-appr-reason">' + icon('lock', 12) + ' 跨机只读 · 不可审批</div>';
      } else if (!dec) {
        actions = '<div class="tl-appr-actions">' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="approve" data-id="' + esc(m.id) + '" data-dec="once">允许一次</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="approve" data-id="' + esc(m.id) + '" data-dec="always">本会话始终允许</button>' +
          '<button type="button" class="btn btn-sm tl-btn-danger" data-act="approve" data-id="' + esc(m.id) + '" data-dec="denied">拒绝</button>' +
        '</div>';
      } else {
        actions = '<div class="tl-appr-actions"><button type="button" class="tl-link" data-act="approve-reset" data-id="' + esc(m.id) + '">撤销重审</button></div>';
      }
    }
    return '<div class="tl"><div class="tl-body">' +
      '<div class="tl-appr' + cls + '">' +
        '<div class="tl-appr-head">' +
          '<span class="tl-ic" style="display:grid;place-items:center;width:20px;color:var(--muted)">' + icon('shield', 14) + '</span>' +
          '<span class="tl-appr-kind">' + esc(m.kind) + '</span>' +
          '<span class="tl-appr-state">' + esc(stateText) + '</span>' +
        '</div>' +
        (m.code ? '<pre class="tl-appr-code">' + highlightCode(m.code, 'bash') + '</pre>' : '') +
        (m.reason ? '<div class="tl-appr-reason">' + esc(m.reason) + '</div>' : '') +
        actions +
      '</div></div></div>';
  }

  function tlPlan(m, key) {
    var tid = 'pl:' + key;
    var open = !!state.openTools[tid];
    var confirmed = state.plansConfirmed[m.id];
    var steps = m.steps || [];
    var done = steps.filter(function (s) { return s.done; }).length;
    return '<div class="tl"><div class="tl-body">' +
      '<div class="tl-plan">' +
        '<div class="tl-plan-head">' +
          '<span class="tl-plan-tag">实施计划</span>' +
          (confirmed ? '<span class="tl-badge is-ok">已确认执行</span>' : '') +
          '<span class="tl-plan-count">' + done + '/' + steps.length + ' 步骤</span>' +
        '</div>' +
        '<h4>' + esc(m.title) + '</h4>' +
        '<ul class="tl-steps">' + steps.map(function (s) {
          return '<li class="tl-step' + (s.done ? ' is-done' : '') + '"><span class="tl-step-box">' + icon('check', 10) + '</span>' +
            '<span class="tl-step-t">' + esc(s.text) + '</span></li>';
        }).join('') + '</ul>' +
        (open && m.body ? '<div class="tl-details"><p>' + esc(m.body) + '</p></div>' : '') +
        '<div class="tl-plan-actions">' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="toggle-tool" data-tid="' + esc(tid) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + (open ? '收起全文' : '展开全文') + '</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="copy-md" data-id="' + esc(m.id) + '">' + icon('copy', 12) + (state.copiedKey === 'md:' + m.id ? '已复制' : '复制 Markdown') + '</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="plan-confirm" data-id="' + esc(m.id) + '"' + (confirmed ? ' disabled' : '') + '>' + icon('play', 12) + (confirmed ? '已确认' : '确认并执行计划') + '</button>' +
        '</div>' +
      '</div></div></div>';
  }

  function tlChangedFiles(list) {
    var add = 0, del = 0;
    list.forEach(function (f) { add += f.add || 0; del += f.del || 0; });
    return '<div class="tl-files">' +
      '<div class="tl-files-head">' + icon('git', 12) + '本轮变更文件 · ' + list.length + ' 个文件' +
        '<span class="tl-files-sum"><span class="add">+' + add + '</span> <span class="del">-' + del + '</span></span></div>' +
      list.map(function (f) {
        return '<button type="button" class="tl-file-row" data-act="file-open" data-file="' + esc(f.n) + '" data-diff="1" title="对比工作区 Diff：' + esc(f.n) + '">' +
          icon('file', 12) +
          '<span class="tl-file-name">' + tlPathHtml(f.n) + '</span>' +
          '<span class="tl-diffstat"><span class="add">+' + (f.add || 0) + '</span> <span class="del">-' + (f.del || 0) + '</span></span>' +
        '</button>';
      }).join('') + '</div>';
  }

  function tlAgentPlainText(m) {
    if (m.text) return m.text;
    return (m.blocks || []).map(function (b) {
      if (b.t === 'code') return '```' + (b.lang || '') + '\n' + (b.code || '') + '\n```';
      if (b.t === 'ul' || b.t === 'ol') return (b.items || []).map(function (x, i) { return (b.t === 'ol' ? (i + 1) + '. ' : '- ') + x; }).join('\n');
      return b.text || '';
    }).join('\n\n');
  }

  function tlAgent(m, key) {
    MSG_TEXT_MAP[key] = tlAgentPlainText(m);
    var msgCopied = state.copiedKey === 'msg:' + key;
    var blocks = (m.blocks || (m.text ? [{ t: 'p', text: m.text }] : [])).map(function (b, i) {
      if (b.t === 'h') return '<h4>' + tlText(b.text) + '</h4>';
      if (b.t === 'ul') return '<ul>' + (b.items || []).map(function (x) { return '<li>' + tlText(x) + '</li>'; }).join('') + '</ul>';
      if (b.t === 'ol') return '<ol>' + (b.items || []).map(function (x) { return '<li>' + tlText(x) + '</li>'; }).join('') + '</ol>';
      if (b.t === 'code') {
        var cid = key + ':c' + i;
        CODE_MAP[cid] = b.code || '';
        var copied = state.copiedKey === cid;
        return '<div class="tl-code"><div class="tl-code-head">' +
          '<span class="tl-code-lang">' + esc(b.lang || 'text') + '</span>' +
          '<button type="button" class="tl-code-copy" data-act="copy-code" data-cid="' + esc(cid) + '" aria-label="复制代码">' +
            icon(copied ? 'check' : 'copy', 11) + (copied ? '已复制' : '复制') + '</button></div>' +
          '<pre>' + highlightCode(b.code || '', b.lang) + '</pre></div>';
      }
      return '<p>' + tlText(b.text || '') + '</p>';
    }).join('');
    var status = m.status === 'stream' ? '<span class="tl-status is-stream">流式生成中…</span>'
      : (m.status === 'cut' ? '<span class="tl-status is-cut">已中断</span>' : '');
    return '<div class="tl tl-agent">' +
      '<div class="tl-body"><div class="tl-who"><span class="tl-name">Harness Agent</span>' +
        (m.model ? '<span class="tl-sub-model">' + esc(m.model) + '</span>' : '') + status + '</div>' +
        '<div class="tl-prose">' + blocks + '</div>' +
        (m.files && m.files.length ? tlChangedFiles(m.files) : '') +
        '<div class="tl-agent-foot">' +
          '<button type="button" class="tl-foot-btn' + (msgCopied ? ' is-copied' : '') + '" data-act="copy-msg" data-mid="' + esc(key) + '" aria-label="' + (msgCopied ? '已复制回复' : '复制回复') + '" title="' + (msgCopied ? '已复制' : '复制回复') + '">' +
            icon(msgCopied ? 'check' : 'copy', 14) + '</button>' +
          '<button type="button" class="tl-foot-btn" data-act="quote-msg" data-mid="' + esc(key) + '" aria-label="引用此回复继续追问" title="引用此回复继续追问">' +
            icon('reply', 14) + '</button>' +
          (m.time ? '<span class="tl-meta">' + esc(m.time) + '</span>' : '') +
        '</div>' +
      '</div></div>';
  }

  function copyText(text, okMsg) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, function () { toast(okMsg + '（剪贴板受限，已展示内容）'); });
        return;
      }
    } catch (e) { /* 剪贴板不可用时只给反馈 */ }
    toast(okMsg);
  }
  function findPlan(id) {
    var s = curSession();
    return (((s && s.msgs) || []).filter(function (m) { return m.w === 'plan' && m.id === id; })[0]) || null;
  }
  function planMarkdown(p) {
    return '# ' + p.title + '\n\n' +
      (p.steps || []).map(function (s) { return '- [' + (s.done ? 'x' : ' ') + '] ' + s.text; }).join('\n') +
      (p.body ? '\n\n' + p.body : '');
  }

  function renderTimeline(list) {
    var pIdx = 0;
    return (list || []).map(function (m, idx) {
      var key = tlIdOf(m, idx);
      if (isHumanMsg(m)) return tlUser(m, pIdx++);
      var done = hasAgentDoneAfter(list, idx);
      switch (m.w) {
        case 'sys-divider': return tlDivider(m);
        case 'sys': return '<div class="tl-note"><span>' + esc(m.text) + '</span></div>';
        case 'reference': return referenceCard(m);
        case 'thinking': return tlThinking(m, key, done);
        case 'workgroup': return tlWorkgroup(m, key, done);
        case 'tool': return tlTool(m, key);
        case 'subagent': return tlSubagent(m, key);
        case 'approval': return tlApproval(m, key);
        case 'plan': return tlPlan(m, key);
        case 'agent': return tlAgent(m, key);
        default: return tlUser(m, pIdx++);
      }
    }).join('');
  }

  function viewChat() {
    var list = mySessions();
    if (!list.length) {
      return '<div class="chat"><div class="chat-scroll"><div class="chat-inner">' +
        emptyBlock('还没有个人会话', '会话只在本机执行，新建一个会话开始。',
          journeyBtn('new-session', '新建会话', '', true)) +
        '</div></div></div>';
    }
    var s = curSession();
    if (!s) { s = list[0]; state.session = s.id; }

    var msgs = renderTimeline(s.msgs || []);
    if (!s.msgs || !s.msgs.length) msgs = '<div class="tl-note"><span>这个会话还没有对话记录</span></div>';

    var draft = esc(state.drafts[s.id] || '');
    var bottomBar = '<div class="composer-wrap"><div class="composer-inner">' +
          '<div id="atMenuMount">' + (state.atq !== null ? atMenuHtml() : '') + '</div>' +
          contextBar(s) +
          '<div class="composer">' +
            '<label class="sr" for="composer">输入指令</label>' +
            '<textarea id="composer" data-role="composer" rows="2" role="combobox" aria-autocomplete="list" aria-expanded="' + (state.atq !== null ? 'true' : 'false') + '" aria-controls="atMenu" placeholder="' + (teamRole(s.team, ME) ? '描述你要做的事，输入 @ 可以引用团队知识' + (s.shareProject ? '或 @成员派任务…' : '…') : '描述你要做的事…') + '">' + draft + '</textarea>' +
            '<div class="composer-bar">' +
              (s.team && teamRole(s.team, ME) ? '<button type="button" class="at-pill-btn" data-act="at-open" aria-label="引用知识" title="引用团队知识 (@)">' + icon('at', 13) + '<span>引用</span></button>' : '') +
              '<span class="hint">只在本机执行 · Enter 发送</span>' +
              '<button type="button" class="send-btn" data-act="send" aria-label="发送" title="发送 (Enter)">' + icon('arrow-up', 15) + '</button>' +
            '</div>' +
          '</div>' +
        '</div></div>';

    var chat =
      '<div class="chat">' +
        '<div class="c4-bar c4-chat-head">' + sessionMeta(s) + '<div class="c4-bar">' +
          (s.agent === 'single' ? '<span class="c4-warning">当前 Agent 仅支持访问主目录</span>' : '') +
          (s.shareProject ? journeyBtn('share-stop', '停止共享') : (publishTargets(s).length ? journeyBtn('share-open', '发布到 Project…') : '')) +
          (teamRole(s.team, ME) ? journeyBtn('proposal-draft', '沉淀为团队知识') : '') +
        '</div></div>' +
        tlMinimapHtml(s.msgs || []) +
        '<div class="chat-scroll" id="chatScroll"><div class="chat-inner">' + msgs + '</div></div>' +
        bottomBar +
      '</div>';

    return '<div class="chat-wrap">' +
      (state.preview ? '<div class="chat-split' + (state.pvMax ? ' is-max' : '') + '">' + chat + filePaneHtml() + '</div>' : chat) +
    '</div>';
  }

  /* 会话未发出第一条用户消息前可改团队上下文,之后只读锁定 */
  function teamCtxBar(s) {
    var locked = (s.msgs || []).some(function (m) { return m.w === s.owner; });
    var team = wsById(s.team).name;
    if (locked) {
      return '<span class="team-ctx is-locked" title="会话已有消息，团队上下文不再更改">' + icon('lock', 11) +
        '团队上下文：' + esc(team) + '（已锁定）<span aria-hidden="true"> · </span>' + esc(visibility(s)) + '</span>';
    }
    return '<button type="button" class="team-ctx" data-act="team-menu" aria-haspopup="menu" aria-expanded="false"' +
      ' title="选择这条会话绑定的团队上下文，发出第一条消息后锁定">' +
      '团队上下文：' + esc(team) + '<span class="chev">' + icon('chev', 11) + '</span><span aria-hidden="true">·</span>' + esc(visibility(s)) + '</button>';
  }

  function atMatches() {
    var groups = atKnowledge();
    var q = (state.atq || '').trim().toLowerCase();
    function match(k) { return !q || (k.title + ' ' + (k.sum || '')).toLowerCase().indexOf(q) >= 0; }
    return { ws: groups.ws.filter(match), proj: groups.proj.filter(match) };
  }

  function atMenuHtml() {
    var groups = atMatches();
    var idx = 0;
    var flatCount = groups.ws.length + groups.proj.length;
    if (state.atIdx >= flatCount) state.atIdx = 0;
    function group(label, items) {
      if (!items.length) return '';
      return '<div class="at-group"><div class="at-group-head"><span class="g-label">' + label + '</span></div>' +
        items.map(function (k) {
          var hl = idx === state.atIdx;
          var optId = 'at-opt-' + idx;
          idx++;
          return '<button type="button" id="' + optId + '" role="option" aria-selected="' + (hl ? 'true' : 'false') + '" class="at-item ' + (hl ? 'is-hl' : '') + '" data-act="at-pick" data-id="' + k.id + '">' + icon('book', 14) +
            '<span class="at-title">' + esc(k.title) + '</span><span class="at-ver">' + esc(k.version) + '</span></button>';
        }).join('') + '</div>';
    }
    var html = group('会话绑定的 Workspace', groups.ws);
    var cs = curSession();
    var sp = cs && projById(cs.shareProject);
    var q = (state.atq || '').trim();
    var totalPpl = sp ? sp.members.filter(function (m) { return m !== ME && (!q || PEOPLE[m].name.indexOf(q) >= 0); }) : [];
    if (state.atIdx >= flatCount + totalPpl.length) state.atIdx = 0;
    if (sp && totalPpl.length) {
      html += '<div class="at-group"><div class="at-group-head"><span class="g-label">@ 成员派任务 · ' + esc(sp.name) + '</span></div>' + totalPpl.map(function (m) {
        var hl = idx === state.atIdx; var optId = 'at-opt-' + idx; idx++;
        return '<button type="button" id="' + optId + '" role="option" aria-selected="' + (hl ? 'true' : 'false') + '" class="at-item ' + (hl ? 'is-hl' : '') + '" data-act="at-person" data-id="' + m + '">' + av(m, 16) + '<span class="at-title">' + esc(PEOPLE[m].name) + '</span><span class="at-ver">派任务</span></button>';
      }).join('') + '</div>';
    } else if (cs && !q) {
      html += '<div class="at-group"><div class="at-group-head"><span class="g-label">@ 成员派任务</span></div><div class="pop-empty">发布到 Project 后可以 @ 成员派任务。</div></div>';
    }
    if (!html) return '<div class="at-menu" id="atMenu"><div class="pop-empty">没有匹配「' + esc(state.atq || '') + '」的知识。</div></div>';
    return '<div class="at-menu" id="atMenu" role="listbox" aria-label="引用知识">' + html + '</div>';
  }

  function viewPeer() {
    var p = curPeer();
    if (!p) return '';
    var proj = projById(p.proj);
    var owner = PEOPLE[p.owner];
    var synced = peerIsSynced(p);

    var brief =
      '<div class="brief-card">' +
        '<div class="brief-top">' + av(p.owner, 34) +
          '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">' +
            '<span style="font-size:var(--text-base);font-weight:600">' + esc(owner.name) + ' 的会话简报</span>' +
            '<span class="meta">' + esc(proj.name) + ' · 最近更新 ' + esc(p.time) + '</span>' +
          '</div>' +
        '</div>' +
        '<p style="font-size:var(--text-md);line-height:1.75;color:var(--fg-2)">' + esc(p.brief) + '</p>' +
        '<ul class="brief-points">' + p.points.map(function (x) {
          return '<li><span class="bullet">·</span><span>' + esc(x) + '</span></li>';
        }).join('') + '</ul>' +
        '<div class="brief-foot">' +
          (synced
            ? '<span class="ro-bar">' + icon('check', 13) + '已同步为只读快照</span>'
            : '<button type="button" class="btn btn-primary" data-act="peer-sync">' + icon('sync', 15) + '同步会话</button>') +
          '<span class="meta">同步只拉取对话与工具摘要，不会在对方机器上执行任何操作。</span>' +
        '</div>' +
      '</div>';

    if (!synced) {
      return '<div class="chat"><div class="chat-scroll"><div class="chat-inner">' + brief +
        '<div class="detail-note">' + icon('lock', 15) +
        '<span>同步之后是只读视图：没有输入框，也不能在这里继续对话。需要落地就「引用到我的会话」或「@成员 派发任务」。</span></div>' +
        '</div></div></div>';
    }

    var msgs = renderTimeline(synced.msgs || []);
    return '<div class="chat">' +
      tlMinimapHtml(synced.msgs || []) +
      '<div class="chat-scroll" id="chatScroll"><div class="chat-inner">' + brief +
        '<div class="ro-bar">' + icon('lock', 13) + (p.archived ? '对方已停止共享 · 保留已同步快照' : '只读快照 · 不可继续对话') + '</div>' + msgs +
      '</div></div>' +
      '<div class="peer-foot"><div class="peer-foot-inner">' +
        '<span class="ro-hint">' + icon('lock', 13) + '只读，无输入框</span>' +
        '<span style="flex:1 1 0"></span>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="peer-cite">' + icon('copy', 14) + '引用到我的会话</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="peer-dispatch">' + icon('at', 14) + '@成员 派发任务</button>' +
      '</div></div>' +
    '</div>';
  }


  /* ═══════════ 看板：默认个人四列状态流 + 管理者成员泳道 + 覆盖式抽屉 ═══════════ */
  var BOARD_COLS = [
    { st: 'open', label: '待接受' },
    { st: 'claimed', label: '待开始' },
    { st: 'running', label: '进行中' },
    { st: 'done', label: '已完成' }
  ];
  function boardTasks() {
    return state.tasks.filter(function (t) {
      var p = projById(t.proj);
      if (!p || p.ws !== state.ws || !projectAccess(p)) return false;
      if (state.boardProj !== 'all' && t.proj !== state.boardProj) return false;
      if (state.boardScope === 'mine' && t.to !== ME) return false;
      if (state.boardScope === 'all' && state.boardOnlyIssues && !(t.status === 'declined' || (t.stale && t.status !== 'done'))) return false;
      return true;
    });
  }
  function colOf(t) { return t.status === 'declined' ? 'open' : t.status; }
  function taskSignals(t) {
    var out = '';
    if (t.status === 'declined') out += '<span class="t-sig bad">已拒绝 · 退回 ' + esc(PEOPLE[t.from].name) + '</span>';
    if (t.status === 'running' && t.live) out += '<span class="t-sig run"><span class="d"></span>本机运行中</span>';
    if (t.stale && t.status !== 'done') out += '<span class="t-sig warn">' + icon('clock', 11) + esc(t.stale) + '</span>';
    if (t.src === 'session') out += '<span class="t-sig" title="来自会话：' + esc(t.srcTitle || '') + '">' + icon('at', 11) + '会话派发</span>';
    return out ? '<span class="t-sigs">' + out + '</span>' : '';
  }
  function cardQuickActions(t, compact) {
    if (compact) return '';
    var btns = [];
    if (t.to === ME && t.status === 'open') {
      btns.push('<button type="button" class="btn btn-primary btn-xs" data-act="claim" data-id="' + t.id + '">接受</button>');
      btns.push('<button type="button" class="btn btn-secondary btn-xs" data-act="task-decline" data-id="' + t.id + '">拒绝</button>');
    } else if (t.to === ME && t.status === 'claimed') {
      btns.push('<button type="button" class="btn btn-primary btn-xs" data-act="start" data-id="' + t.id + '">在本机开始</button>');
    } else if (t.to === ME && t.status === 'running') {
      if (t.sessionId && mySessions().some(function (s) { return s.id === t.sessionId; })) {
        btns.push('<button type="button" class="btn btn-secondary btn-xs" data-act="goto-session" data-id="' + t.sessionId + '">进入会话</button>');
      }
      btns.push('<button type="button" class="btn btn-secondary btn-xs" data-act="finish" data-id="' + t.id + '">标记完成</button>');
    } else if (t.status === 'declined' && t.from === ME) {
      btns.push('<button type="button" class="btn btn-secondary btn-xs" data-act="task-reassign" data-id="' + t.id + '">改派给他人</button>');
    }
    return btns.length ? '<div class="tcard-acts">' + btns.join('') + '</div>' : '';
  }
  function taskCard(t, compact) {
    var on = state.taskSel === t.id;
    var pj = projById(t.proj);
    return '<article class="tcard' + (on ? ' is-active' : '') + (compact ? ' is-compact' : '') + (t.status === 'declined' ? ' is-declined' : '') + '">' +
      '<button type="button" class="tcard-main" data-act="task-open" data-id="' + t.id + '" data-focus="task-' + t.id + '">' +
        '<span class="t-title">' + esc(t.title) + '</span>' +
        (compact ? '' : '<span class="t-meta">' + av(t.to, 18) + '<span>' + esc(PEOPLE[t.to].name) + '</span>' +
          '<span class="prio ' + t.prio + '">' + PRIO_TEXT[t.prio] + '</span>' +
          (state.boardProj === 'all' ? '<span class="t-proj od-truncate">' + esc(pj.name) + '</span>' : '') + '</span>') +
        taskSignals(t) +
      '</button>' +
      cardQuickActions(t, compact) +
    '</article>';
  }
  function boardByStatus(list) {
    return '<div class="board">' + BOARD_COLS.map(function (c) {
      var items = list.filter(function (t) { return colOf(t) === c.st; });
      return '<div class="col"><div class="col-head"><span class="c-dot ' + c.st + '"></span><span class="c-name">' + c.label + '</span>' +
        '<span class="c-count">' + items.length + '</span></div>' +
        '<div class="col-body">' + (items.length ? items.map(function (t) { return taskCard(t); }).join('') : '<div class="col-empty">暂无任务</div>') +
        '</div></div>';
    }).join('') + '</div>';
  }
  function memberActiveSession(member) {
    if (member === ME) {
      var ms = mySessions().filter(function (s) { return s.shareProject && (state.boardProj === 'all' || s.shareProject === state.boardProj); })[0];
      return ms ? { kind: 'me', id: ms.id, title: ms.title, running: !!ms.running } : null;
    }
    var projs = state.boardProj === 'all' ? wsProjects() : [projById(state.boardProj)].filter(Boolean);
    for (var i = 0; i < projs.length; i++) {
      var ps = peersOf(projs[i].id).filter(function (p) { return p.owner === member; });
      if (ps.length) {
        var top = ps.filter(function (p) { return p.sync === 'updated'; })[0] || ps[0];
        return { kind: 'peer', id: top.id, owner: top.owner, title: top.title, upd: top.sync === 'updated' };
      }
    }
    return null;
  }
  function boardByMember(list) {
    var people = [];
    var projs = state.boardProj === 'all' ? wsProjects() : [projById(state.boardProj)].filter(Boolean);
    projs.forEach(function (p) { p.members.forEach(function (m) { if (people.indexOf(m) < 0) people.push(m); }); });
    if (state.boardScope === 'mine') people = [ME];
    people.sort(function (a, b) { return a === ME ? -1 : b === ME ? 1 : 0; });
    var head = '<div class="mb-row mb-head"><span class="mb-who">成员与活跃会话</span>' + BOARD_COLS.map(function (c) {
      return '<span class="mb-cell-h"><span class="c-dot ' + c.st + '"></span>' + c.label + '</span>';
    }).join('') + '</div>';
    var rows = people.map(function (m) {
      var mine = list.filter(function (t) { return t.to === m; });
      var openN = mine.filter(function (t) { return t.status !== 'done'; }).length;
      var stale = mine.some(function (t) { return t.stale && t.status !== 'done'; });
      var actSess = memberActiveSession(m);
      var sessHtml = actSess
        ? (actSess.kind === 'me'
            ? '<button type="button" class="mb-sess" data-act="session" data-id="' + actSess.id + '" title="打开会话">' +
                '<span class="ms-dot"></span><span class="od-truncate">' + esc(actSess.title) + '</span></button>'
            : '<button type="button" class="mb-sess" data-act="pop-open" data-owner="' + actSess.owner + '" data-id="' + actSess.id + '" title="查看队友简报">' +
                '<span class="ms-dot' + (actSess.upd ? ' upd' : '') + '"></span><span class="od-truncate">' + esc(actSess.title) + '</span></button>')
        : '';
      return '<div class="mb-row"><span class="mb-who">' + av(m, 26) + '<span class="od-stack" style="--od-gap:1px;min-width:0">' +
        '<span class="od-truncate">' + esc(PEOPLE[m].name) + (m === ME ? '（我）' : '') + '</span>' +
        '<span class="meta">未完成 ' + openN + (stale ? ' · <span class="warn-txt">有停滞</span>' : '') + '</span>' +
        sessHtml + '</span></span>' +
        BOARD_COLS.map(function (c) {
          var items = mine.filter(function (t) { return colOf(t) === c.st; });
          return '<span class="mb-cell">' + (items.length ? items.map(function (t) { return taskCard(t, true); }).join('') : '<span class="mb-none">—</span>') + '</span>';
        }).join('') + '</div>';
    }).join('');
    return '<div class="mboard" role="table" aria-label="按成员泳道查看任务">' + head + rows + '</div>';
  }
  function segHtml(act, cur, opts, label) {
    return '<div class="seg" data-seg-key="' + esc(act) + '" role="tablist" aria-label="' + label + '">' + opts.map(function (o) {
      var on = cur === o[0];
      return '<button type="button" role="tab" class="' + (on ? 'is-active' : '') + '" data-act="' + act + '" data-id="' + o[0] + '" data-focus="' + act + '-' + o[0] + '" aria-selected="' + on + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function teamHealthBar() {
    var all = state.tasks.filter(function (t) {
      var p = projById(t.proj);
      if (!p || p.ws !== state.ws || !projectAccess(p)) return false;
      if (state.boardProj !== 'all' && t.proj !== state.boardProj) return false;
      return true;
    });
    var isMemberView = state.boardView === 'member';
    var cIssues = all.filter(function (t) { return t.status === 'declined' || (t.stale && t.status !== 'done'); }).length;
    var openTotal = all.filter(function (t) { return t.status !== 'done'; }).length;
    if (!cIssues && !isMemberView) return '';
    return '<div class="board-health">' +
      (isMemberView ? '<span class="bh-stat">未完成总计 <strong>' + openTotal + '</strong></span>' : '') +
      (cIssues ? '<button type="button" class="bh-issue' + (state.boardOnlyIssues ? ' is-on' : '') + '" data-act="board-issues" aria-pressed="' + state.boardOnlyIssues + '">' +
        icon('clock', 12) + '异常 / 停滞 ' + cIssues + (state.boardOnlyIssues ? '（已筛 · 点此恢复）' : '') + '</button>' : '') +
      '<span class="board-note">' + (isMemberView ? '点击成员下方会话可只读查看进展或追问派发' : '可切到「成员泳道」一屏查看负载与活跃会话') + '</span>' +
    '</div>';
  }
  function viewBoard() {
    if (!teamRole(state.ws, ME)) {
      return emptyBlock('当前账号未加入团队', NO_TEAM_HINT, journeyBtn('space', '回到个人空间', 'personal', true));
    }
    var list = boardTasks();
    var isTeamScope = state.boardScope === 'all';
    if (!isTeamScope && state.boardView === 'member') state.boardView = 'status';
    var projPick = '';
    if (LAYOUT_MODE === 'B') {
      var projs = wsProjects();
      projPick = '<label class="sr" for="boardProjSel">筛选 Project</label>' +
        '<select id="boardProjSel" class="c4-select" data-role="board-proj-sel">' +
        '<option value="all"' + (state.boardProj === 'all' ? ' selected' : '') + '>全部 Project</option>' +
        projs.map(function (p) { return '<option value="' + p.id + '"' + (state.boardProj === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') +
        '</select>' +
        (state.boardProj !== 'all' ? '<button type="button" class="icon-btn" data-act="collab-nav" data-proj="' + state.boardProj + '" data-view="project" title="Project 资料与成员" aria-label="Project 资料与成员">' + icon('sliders', 14) + '</button>' : '');
    }
    var bar = '<div class="view-bar">' +
      segHtml('board-scope', state.boardScope, [['mine', '我的'], ['all', '团队总览']], '看板视角') +
      (isTeamScope ? segHtml('board-view', state.boardView, [['status', '状态看板'], ['member', '成员泳道']], '看板形态') : '') +
      projPick +
      '<span class="vb-spacer"></span>' +
      (!isTeamScope ? '<span class="meta">我发布的任务进度在「Inbox → 我发起的」追踪</span>' : '') +
      journeyBtn('task-new', '新建并指派任务', '', true) + '</div>';
    var health = isTeamScope ? teamHealthBar() : '';
    var body = !list.length
      ? emptyBlock(state.boardOnlyIssues ? '没有异常或停滞任务' : (state.boardScope === 'mine' ? '当前没有指派给你的任务' : '这里还没有任务'),
          state.boardOnlyIssues ? '点上方筛选按钮恢复显示全部任务。' : '可以切到「团队总览」看看团队进展，或新建并指派任务。', '')
      : (isTeamScope && state.boardView === 'member' ? boardByMember(list) : boardByStatus(list));
    var cur = state.taskSel && taskById(state.taskSel);
    if (cur && !projectAccess(projById(cur.proj))) cur = null;
    return bar + health + '<div class="bv-wrap">' + body + '</div>' +
      (cur ? '<div class="t-drawer-backdrop" data-act="task-close"></div>' +
        '<aside class="t-drawer" aria-label="任务详情"><button type="button" class="icon-btn t-drawer-x" data-act="task-close" aria-label="关闭任务详情" title="关闭 (Esc)">' + icon('x', 15) + '</button>' + taskDetail(cur) + '</aside>' : '');
  }

  function taskDetail(t) {
    var pj = projById(t.proj);
    var html = '<div class="detail">' +
      '<div class="od-stack" style="--od-gap:4px"><h2>' + esc(t.title) + '</h2>' +
      '<span class="meta">' + esc(pj.name) + ' · ' + esc(t.time) + '</span></div>' +
      '<p class="desc">' + esc(t.desc) + '</p>' +
      '<dl class="kv">' +
        '<dt>发布人</dt><dd>' + av(t.from, 20) + '<span>' + esc(PEOPLE[t.from].name) + '</span></dd>' +
        '<dt>指派给</dt><dd>' + av(t.to, 20) + '<span>' + esc(PEOPLE[t.to].name) + ' · ' + esc(PEOPLE[t.to].role) + '</span></dd>' +
        '<dt>来源</dt><dd style="color:var(--fg-2)">' + (t.src === 'session' ? '对话 @ 派发' + (t.srcTitle ? ' ·《' + esc(t.srcTitle) + '》' : '') : '看板派发') + '</dd>' +
        '<dt>优先级</dt><dd><span class="prio ' + t.prio + '">' + PRIO_TEXT[t.prio] + '</span></dd>' +
        '<dt>当前状态</dt><dd><span class="status-badge ' + t.status + '">' + STATUS_TEXT[t.status] + '</span>' + (t.stale && t.status !== 'done' ? '<span class="t-sig warn">' + esc(t.stale) + '</span>' : '') + '</dd>' +
        '<dt>创建时间</dt><dd style="color:var(--fg-2)">' + esc(t.time) + '</dd>' +
        (t.sessionId && mySessions().some(function (s) { return s.id === t.sessionId; })
          ? '<dt>关联会话</dt><dd><button type="button" class="btn btn-ghost btn-sm" data-act="goto-session" data-id="' + t.sessionId + '" style="padding-left:0">' +
            icon('file', 14) + esc((state.sessions.filter(function (s) { return s.id === t.sessionId; })[0] || {}).title) + '</button></dd>'
          : '') +
      '</dl>';
    var note = '';
    if (t.status === 'declined') note = icon('x', 15) + '<span>' + esc(PEOPLE[t.to].name) + ' 拒绝了这个任务：' + esc(t.reason || '未填写理由') + '。发布人可以直接改派。</span>';
    else if (t.to !== ME) note = icon('lock', 15) + '<span>这个任务指派给了 ' + esc(PEOPLE[t.to].name) + '。只有被指派人可以接受和在本机开始。</span>';
    else if (t.status === 'open') note = icon('dot', 15) + '<span>先接受或拒绝。接受后进入「待开始」列，不会自动启动任何进程；拒绝会附理由退回给发布人。</span>';
    else if (t.status === 'claimed') note = icon('lock', 15) + '<span>已接受并待开始。下一步「在本机开始」需要你自己选会话和工作目录。</span>';
    else if (t.status === 'running') note = icon('clock', 15) + '<span>正在本机执行。会话结束之后再标记完成，发布人会收到结果回执。</span>';
    else note = icon('check', 15) + '<span>这个任务已经完成，发布人已收到回执。</span>';
    html += '<div class="detail-note">' + note + '</div><div class="detail-actions">';
    if (t.to === ME && t.status === 'open') {
      html += '<button type="button" class="btn btn-primary" data-act="claim" data-id="' + t.id + '" data-focus="claim-' + t.id + '">' + icon('check', 15) + '接受任务</button>' +
        '<button type="button" class="btn btn-secondary" data-act="task-decline" data-id="' + t.id + '">拒绝</button>';
    }
    if (t.to === ME && t.status === 'claimed') {
      html += '<button type="button" class="btn btn-primary" data-act="start" data-id="' + t.id + '" data-focus="start-' + t.id + '">' + icon('send', 15) + '在本机开始</button>';
    }
    if (t.to === ME && t.status === 'running') {
      html += '<button type="button" class="btn btn-secondary" data-act="finish" data-id="' + t.id + '" data-focus="finish-' + t.id + '">' + icon('check', 15) + '标记完成</button>';
    }
    if (t.status === 'declined' && t.from === ME) {
      html += '<button type="button" class="btn btn-primary" data-act="task-reassign" data-id="' + t.id + '">改派给他人</button>';
    }
    if (t.status === 'done') {
      html += '<span class="meta">已完成，无需再操作。</span>';
    }
    html += '</div></div>';
    return html;
  }

  /* ═══════════ Inbox 视图 ═══════════ */
  function ibBadge(it) { return '<span class="ib-type t-' + it.type + '">' + REQ_TYPE[it.type] + '</span>'; }
  function inboxDetail(it, tab) {
    var r = it.ref;
    var head = '<div class="od-row" style="flex-wrap:wrap;--od-gap:8px">' + ibBadge(it) + (it.ws ? wsDot(it.ws) + '<span class="meta">' + esc(wsById(it.ws).name) + '</span>' : '') +
      (it.st ? '<span class="kb">' + esc(it.st) + '</span>' : '') + '</div>';
    if (it.type === 'task') {
      var acts = tab === 'todo'
        ? '<div class="c4-bar">' + journeyBtn('claim', '接受任务', r.id, true) + journeyBtn('task-decline', '拒绝', r.id) + journeyBtn('task-jump', '在看板中查看', r.id) + '</div>'
        : '<div class="c4-bar">' + (r.status === 'declined' ? journeyBtn('task-reassign', '改派给他人', r.id, true) : '') + journeyBtn('task-jump', '在看板中查看', r.id) + '</div>';
      return head + '<h2>' + esc(r.title) + '</h2><p class="k-note">' + esc(it.src) + ' · ' + esc(PEOPLE[r.from].name) + ' → ' + esc(PEOPLE[r.to].name) + ' · ' + esc(r.time) + '</p>' +
        '<p class="k-body">' + esc(r.desc) + '</p>' + (r.reason ? '<div class="k-warn"><span>拒绝理由：' + esc(r.reason) + '</span></div>' : '') +
        '<p class="k-note">' + (tab === 'todo' ? '接受后进入看板「待开始」列，什么时候在本机开始由你决定。' : '对方接受、开始、拒绝或完成时，状态会实时同步到这里和看板。') + '</p>' + acts;
    }
    if (it.type === 'prop' || it.type === 'map') return proposalDetailHtml(r, isAdmin(it.ws));
    return head + '<h2>' + esc(PEOPLE[r.from].name) + ' ' + esc(reqTitle(r)) + '</h2><p class="k-note">' + esc(it.time) + '</p>' +
      '<p class="k-body">' + esc(r.note || '') + '</p>' + (r.reason ? '<div class="k-warn"><span>拒绝理由：' + esc(r.reason) + '</span></div>' : '') +
      (tab === 'todo' ? '<div class="c4-bar">' + journeyBtn('req-approve', '同意', r.id, true) + journeyBtn('req-reject', '拒绝', r.id) + '</div>' : '');
  }
  function viewInbox() {
    var tab = state.inboxTab === 'sent' ? 'sent' : 'todo';
    var all = inboxItems();
    var list = (all[tab] || []).filter(function (it) { return inboxTypeOk(it); });
    if (LAYOUT_MODE === 'A') {
      var topBar = !state.side ? '<div class="view-bar">' +
        segHtml('inbox-tab', tab, [['todo', '待我处理 ' + all.todo.length], ['sent', '我发起的 ' + all.sent.length]], 'Inbox 分组') +
        '<span class="vb-spacer"></span>' + journeyBtn('side-toggle', '展开左侧审批列表') + '</div>' : '';
      if (!list.length) {
        return topBar + emptyBlock(tab === 'todo' ? '没有需要你拍板的审批事项' : '你还没有发起请求',
          '只汇总任务指派、团队知识审核、系统地图审核和成员角色申请；本机权限批准留在原会话。', '');
      }
      if (!list.some(function (it) { return it.key === state.inboxSel; })) state.inboxSel = list[0].key;
      var curA = list.filter(function (it) { return it.key === state.inboxSel; })[0];
      return topBar + '<div class="ib-single-wrap"><article class="k-doc">' + inboxDetail(curA, tab) + '</article></div>';
    }
    var types = [['all', '全部'], ['task', '任务指派'], ['know', '知识与地图'], ['member', '成员与角色']];
    var tabs = segHtml('inbox-tab', tab, [['todo', '待我处理 ' + all.todo.length], ['sent', '我发起的 ' + all.sent.length]], 'Inbox 分组');
    var typeChips = '<div class="pane-chips" role="tablist" aria-label="按类型筛选">' + types.map(function (t) {
      var n = (all[tab] || []).filter(function (it) { return inboxTypeOk(it, t[0]); }).length;
      if (t[0] !== 'all' && !n) return '';
      var on = state.inboxType === t[0];
      return '<button type="button" role="tab" class="pane-chip' + (on ? ' is-active' : '') + '" data-act="inbox-type" data-id="' + t[0] + '" data-focus="ibf-' + t[0] + '" aria-selected="' + on + '">' + t[1] + ' ' + n + '</button>';
    }).join('') + '</div>';
    var bar = '<div class="view-bar">' + tabs + typeChips + '<span class="vb-spacer"></span><span class="meta">仅汇总跨人审批；本机权限留在原会话</span></div>';
    if (!list.length) {
      return bar + emptyBlock(tab === 'todo' ? '没有需要你处理的事项' : '你还没有发起请求',
        tab === 'todo' ? '有人给你派任务、提交知识等你审核或申请团队权限时，会出现在这里。' : '在看板派任务、在对话 @ 成员或沉淀团队知识后，可以在这里跟踪进度。', '');
    }
    if (!list.some(function (it) { return it.key === state.inboxSel; })) state.inboxSel = list[0].key;
    var cur = list.filter(function (it) { return it.key === state.inboxSel; })[0];
    var rows = list.map(function (it) {
      var on = it.key === cur.key;
      return '<button type="button" class="k-row ib-row' + (on ? ' is-active' : '') + '" data-act="inbox-sel" data-id="' + esc(it.key) + '" data-focus="ib-' + esc(it.key) + '"' + (on ? ' aria-current="true"' : '') + '>' +
        '<span class="ib-top">' + ibBadge(it) + '<span class="kr-title od-truncate">' + esc(it.title) + '</span></span>' +
        '<span class="kr-meta">' + (it.who ? av(it.who, 16) + '<span>' + esc(PEOPLE[it.who].name) + '</span><span>·</span>' : '') +
          (it.ws ? wsDot(it.ws) : '') + '<span class="od-truncate">' + esc(it.src) + '</span><span>·</span><span class="od-nowrap">' + esc(it.time) + '</span>' +
          (it.st ? '<span class="kb">' + esc(it.st) + '</span>' : '') + '</span></button>';
    }).join('');
    return bar + '<div class="review-layout"><div class="k-side" role="list">' + rows + '</div><article class="k-doc">' + inboxDetail(cur, tab) + '</article></div>';
  }

  function viewKnowledge() {
    var ws = curWs();
    if (!ws.id) {
      return emptyBlock('当前账号未加入团队', '团队知识库只对 Workspace 成员开放；本机 Agent 与个人会话照常可用。',
        journeyBtn('perspective', '切换演示视角', '', true));
    }
    var admin = isAdmin(state.ws);
    var pend = pendingProposals();
    if (state.kscope === 'pending' || state.kscope === 'mine') state.kscope = 'all';

    var pendBanner = pend.length
      ? '<div class="ib-banner"><span>当前有 <strong>' + pend.length + '</strong> 条知识 / 系统地图提议正在等待管理员审核（批准前不会进入任何人的 Agent）</span>' +
          journeyBtn('inbox-go', admin ? '去 Inbox 审核' : '在 Inbox 看我的提议', admin ? 'todo' : 'sent') + '</div>'
      : '';

    var filters = [
      { id: 'all', label: '全部已发布' }, { id: 'rule', label: '规约' }, { id: 'exp', label: '经验' },
      { id: 'term', label: '术语' }, { id: 'map', label: '系统地图' }
    ];
    var bar = LAYOUT_MODE === 'A'
      ? '<div class="view-bar">' + (!state.side ? journeyBtn('side-toggle', '展开左侧知识目录') : '') +
          '<span class="meta">' + esc(ws.name) + ' · ' + esc(LEVEL_TEXT[state.kscope] || '全部已发布') + '</span>' +
          '<span class="vb-spacer"></span>' +
          (admin ? journeyBtn('organize', '定期整理') : '') +
          journeyBtn('proposal-draft', '沉淀为团队知识', '', true) + '</div>' + pendBanner
      : '<div class="view-bar"><div class="seg" role="tablist" aria-label="知识筛选">' +
          filters.map(function (f) {
            var on = state.kscope === f.id;
            return '<button type="button" role="tab" class="' + (on ? 'is-active' : '') + '" data-act="kscope" data-scope="' + f.id +
              '" data-focus="kl-' + f.id + '" aria-selected="' + on + '">' + esc(f.label) + '</button>';
          }).join('') + '</div><span class="vb-spacer"></span>' +
          (admin ? journeyBtn('organize', '定期整理') : '') +
          journeyBtn('proposal-draft', '沉淀为团队知识', '', true) + '</div>' + pendBanner;

    if (state.kscope === 'map') return bar + sysMapHtml();

    var list = publishedKnowledge().filter(function (k) { return state.kscope === 'all' || k.level === state.kscope; });
    if (!list.length) {
      return bar + emptyBlock('这个分组下还没有已发布内容', '切换其他分组，或者从会话里沉淀一条新知识：先提交到 Inbox 审核，批准后发布。',
        journeyBtn('proposal-draft', '沉淀为团队知识', '', true));
    }
    if (!list.some(function (k) { return k.id === state.kSel; })) state.kSel = list[0].id;
    var cur = list.filter(function (k) { return k.id === state.kSel; })[0] || list[0];

    var actions = state.kEdit
      ? '<button type="button" class="btn btn-primary btn-sm" data-act="k-save" data-id="' + cur.id + '">保存并升级版本</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="k-cancel">取消</button>'
      : (admin
          ? '<button type="button" class="btn btn-secondary btn-sm" data-act="k-edit" data-id="' + cur.id + '">' + icon('pen', 13) + '编辑</button>'
          : '<button type="button" class="btn btn-secondary btn-sm" data-act="k-propose" data-id="' + cur.id + '">' + icon('reply', 13) + '发起修订提议</button>') +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="cite-knowledge" data-id="' + cur.id + '" title="把这条知识插入到本机会话输入框">' + icon('at', 14) + '引用到会话</button>';

    var docSummary = state.kEdit
      ? '<label class="sr" for="kSumEdit">一句话结论</label><input type="text" class="k-sum-edit" id="kSumEdit" value="' + esc(cur.sum) + '" placeholder="概括这条知识约束了什么">'
      : '<p class="k-sum">' + esc(cur.sum) + '</p>';
    var docBody = state.kEdit
      ? '<textarea class="k-body-edit" id="kEditArea" aria-label="知识正文">' + esc(cur.body || cur.sum) + '</textarea>'
      : '<p class="k-body">' + esc(cur.body || cur.sum) + '</p>';

    var hist = (cur.hist || []).map(function (h) {
      return '<div class="k-hist-item">' + av(h.who, 22) +
        '<span>' + esc(PEOPLE[h.who] ? PEOPLE[h.who].name : h.who) + '</span>' +
        '<span class="role-tag">' + esc(h.act) + '</span>' +
        '<span class="meta">' + esc(h.ver) + ' · ' + esc(h.date) + '</span></div>';
    }).join('');

    var docHtml = '<article class="k-doc">' +
      '<div class="od-row" style="--od-gap:8px;flex-wrap:wrap">' + kBadges(cur) + '<span style="flex:1 1 0"></span>' + actions + '</div>' +
      '<h2>' + esc(cur.title) + '</h2>' +
      '<p class="k-note">' + esc(LEVEL_NOTE[cur.level] || '') + ' · 适用范围 ' + esc(cur.applies || '全团队') +
        ' · 归属 ' + esc(wsById(cur.ws).name) + ' · ' + esc(cur.updated) + ' 更新</p>' +
      docSummary + docBody +
      '<div class="k-hist">' +
        '<span class="kh-title">贡献与审核历史</span>' + hist +
        '<span class="k-hist-note">会话引用会锁定当前版本号；批准发布才会递增小版本，历史会话仍可溯源到旧版本。</span>' +
      '</div>' +
    '</article>';

    if (LAYOUT_MODE === 'A') return bar + '<div class="ib-single-wrap">' + docHtml + '</div>';

    var rows = list.map(function (k) {
      var on = k.id === cur.id;
      return '<button type="button" class="k-row ' + (on ? 'is-active' : '') + '" data-act="k-select" data-id="' + k.id + '"' +
        (on ? ' aria-current="true"' : '') + '>' +
        '<span class="kr-title">' + esc(k.title) + '</span>' +
        '<span class="kr-meta">' + kBadges(k) + '<span>' + esc(k.updated) + '</span></span></button>';
    }).join('');
    return bar + '<div class="knowledge-layout"><div class="k-side" role="list">' + rows + '</div>' + docHtml + '</div>';
  }

  function viewProject() {
    var proj = curProj(), ws = curWs();
    var members = proj.members.map(function (m) {
      var p = PEOPLE[m];
      return '<div class="member-row">' + av(m, 30) +
        '<span style="display:flex;flex-direction:column;gap:0;min-width:0;flex:1 1 0">' +
          '<span class="m-name od-truncate">' + esc(p.name) + '</span>' +
          '<span class="m-role">' + esc(p.role) + '</span></span>' +
        '<span class="role-tag">' + (m === proj.lead ? 'Project 负责人' : 'Project 成员') + '</span>' +
        (p.lead ? '<span class="role-tag">组长</span>' : '') +
        '</div>';
    }).join('');

    var infoBody = state.projEdit
      ? '<div class="fld"><label for="peName">项目名<span class="req" aria-hidden="true">*</span></label><input type="text" id="peName" value="' + esc(proj.name) + '" aria-describedby="peNameErr"><p class="err" id="peNameErr" hidden></p></div>' +
        '<div class="fld"><label for="peDesc">项目说明</label><textarea id="peDesc" placeholder="简述项目目标、负责模块或协作边界">' + esc(proj.desc || '') + '</textarea></div>' +
        '<div class="fld"><label for="peRepo">关联仓库</label><input type="text" id="peRepo" value="' + esc(proj.repo || '') + '" placeholder="pay/checkout-split"></div>' +
        '<div class="od-cluster" style="padding-top:4px">' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="proj-save">保存资料</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="proj-cancel">取消</button>' +
        '</div>'
      : '<dl class="kv">' +
          '<dt>项目名</dt><dd>' + esc(proj.name) + '</dd>' +
          '<dt>项目说明</dt><dd style="color:var(--fg-2);line-height:1.65">' + esc(proj.desc || '暂无项目说明，可点击右上角编辑补充。') + '</dd>' +
          '<dt>所属</dt><dd>' + esc(ws.name) + '</dd>' +
          '<dt>仓库</dt><dd class="mono" style="font-size:var(--text-xs);color:var(--fg-2)">' + (proj.repo ? esc(proj.repo) : '未关联') + '</dd>' +
          '<dt>创建于</dt><dd style="color:var(--fg-2)">' + esc(proj.created) + '</dd>' +
        '</dl>' +
        '<div class="stat-row">' +
          '<div class="stat"><span class="n">' + mySessions().filter(function (s) { return s.shareProject === proj.id; }).length + '</span><span class="l">我的已发布会话</span></div>' +
          '<div class="stat"><span class="n">' + tasksOf(proj.id).length + '</span><span class="l">任务</span></div>' +
          '<div class="stat"><span class="n">' + peersOf(proj.id).filter(function (p) { return !p.archived; }).length + '</span><span class="l">队友简报</span></div>' +
        '</div>';

    var memberPanel = state.projEdit
      ? '<div class="panel"><h2>成员范围 · ' + proj.members.length + ' 人</h2>' +
          ws.members.map(function (m) {
            var p = PEOPLE[m], on = proj.members.indexOf(m) >= 0, me = m === ME;
            return '<label class="member-pick chk">' +
              '<input type="checkbox" name="peMember" value="' + m + '"' + (on ? ' checked' : '') + (me ? ' disabled' : '') + '>' +
              av(m, 24) + '<span class="mp-name">' + esc(p.name) + (m === proj.lead ? ' <span class="meta">（Project 负责人）</span>' : '') + '</span>' +
              '<span class="mp-role">' + esc(p.role) + '</span></label>';
          }).join('') +
        '</div>'
      : '<div class="panel"><h2>成员 · ' + proj.members.length + ' 人</h2>' + members +
          '<p class="meta" style="line-height:1.7">会话同步按 Project 维度生效：只有这里的成员，他们的会话才会出现在顶栏成员条和速览浮层里。</p>' +
        '</div>';

    return '<div class="view-bar">' +
      '<span class="vb-spacer"></span>' +
      (state.projEdit || proj.lead !== ME ? '' : '<button type="button" class="btn btn-secondary btn-sm" data-act="proj-edit" data-focus="vb-proj-edit">' + icon('pen', 13) + '编辑资料与成员</button>') +
      '</div>' +
      '<div class="info-grid">' +
        '<div class="panel"><div class="panel-head"><h2>项目资料</h2></div>' + infoBody + '</div>' +
        memberPanel +
      '</div>';
  }

  function renderSettings() {
    var body = $('#settingsBody');
    if (!body) return;
    var dark = state.theme === 'dark';
    var accents = [
      { id: 'violet', label: '靛紫', dot: dark ? '#8c93f8' : '#5b63d3' },
      { id: 'indigo', label: '靛蓝', dot: dark ? '#82a0ff' : '#2b59e8' },
      { id: 'teal', label: '松石绿', dot: dark ? '#46c7ae' : '#09695a' },
      { id: 'ink', label: '极简黑', dot: dark ? '#ededf0' : '#171717' }
    ];
    var ws = curWs();
    put(body,
      '<div class="set-row"><span class="s-main"><span class="s-label">演示视角切换</span><span class="s-help">角色与会话按账号区分，切换不改变成员权限。</span></span></div>' + perspectiveChoices() +
      '<div class="set-section-title" style="margin-top:0;padding-top:0">外观与布局</div>' +
      '<div class="set-row"><span class="s-main"><span class="s-label">主题</span><span class="s-help">浅色是默认；深色单独配色，不是简单反色。</span></span>' +
        '<div class="seg" role="radiogroup" aria-label="主题">' +
          '<button type="button" role="radio" class="' + (!dark ? 'is-active' : '') + '" data-act="theme-set" data-theme-id="light" data-focus="set-theme-light" aria-checked="' + (!dark) + '">浅色</button>' +
          '<button type="button" role="radio" class="' + (dark ? 'is-active' : '') + '" data-act="theme-set" data-theme-id="dark" data-focus="set-theme-dark" aria-checked="' + (dark) + '">深色</button>' +
        '</div></div>' +
      '<div class="set-row"><span class="s-main"><span class="s-label">强调色</span><span class="s-help">只落在主操作、指示线、微点和 @ 前缀上。</span></span>' +
        '<div class="swatches">' + accents.map(function (a) {
          return '<button type="button" class="swatch ' + (state.accent === a.id ? 'is-active' : '') + '" data-act="accent" data-accent-id="' + a.id + '" data-focus="set-accent-' + a.id + '"' +
            ' style="--dot:' + a.dot + '" aria-pressed="' + (state.accent === a.id) + '"><span class="chip"></span>' + a.label + '</button>';
        }).join('') + '</div></div>' +
      '<div class="set-row"><span class="s-main"><span class="s-label">界面密度</span><span class="s-help">只改留白，不改字号。</span></span>' +
        '<div class="seg" role="radiogroup" aria-label="界面密度">' +
          ['compact','standard','wide'].map(function (d) {
            var label = { compact: '紧凑', standard: '标准', wide: '宽松' }[d];
            return '<button type="button" role="radio" class="' + (state.density === d ? 'is-active' : '') + '" data-act="density" data-density-id="' + d + '" data-focus="set-density-' + d + '" aria-checked="' + (state.density === d) + '">' + label + '</button>';
          }).join('') +
        '</div></div>' +
      '<div class="set-row"><span class="s-main"><span class="s-label">界面缩放</span><span class="s-help">小窗口或高分屏用，不改字号层级。</span></span>' +
        '<div class="seg" role="radiogroup" aria-label="界面缩放">' +
          [0.9, 1, 1.1].map(function (z) {
            return '<button type="button" role="radio" class="' + (state.zoom === z ? 'is-active' : '') + '" data-act="zoom" data-zoom="' + z + '" data-focus="set-zoom-' + z + '" aria-checked="' + (state.zoom === z) + '">' + Math.round(z * 100) + '%</button>';
          }).join('') +
        '</div></div>' +
      '<div class="set-section-title">快捷键</div>' +
      '<div class="kbd-grid">' +
        '<div class="kbd-item"><span>全局搜索</span><span class="kbd">⌘K</span></div>' +
        '<div class="kbd-item"><span>收起 / 展开左栏</span><span class="kbd">⌘\\</span></div>' +
        '<div class="kbd-item"><span>引用团队知识</span><span class="kbd">@</span></div>' +
        '<div class="kbd-item"><span>关闭浮层或预览</span><span class="kbd">Esc</span></div>' +
      '</div>' +
      '<div class="set-section-title">账号与团队</div>' +
      '<div class="set-row"><span class="s-main"><span class="s-label">当前账号</span><span class="s-help">' + esc(PEOPLE[ME].name) + ' · ' + esc(teamRole(ws.id, ME) || '未加入团队') + '</span></span>' +
        '<span class="role-tag">本机可执行</span></div>' +
      roleBody(ws));
  }
  function openSettings() {
    renderSettings();
    openDialog('dlgSettings', '#settingsBody .set-row .seg button');
  }

  function emptyBlock(title, body, actions) {
    return '<div class="empty-block"><span class="eb-title">' + esc(title) + '</span>' +
      '<span class="eb-body">' + body + '</span>' + (actions ? '<div class="od-cluster" style="justify-content:center">' + actions + '</div>' : '') + '</div>';
  }

  function scrollChatToEnd() {
    var el = $('#chatScroll');
    if (el) el.scrollTop = el.scrollHeight;
  }

  /* ═══════════ 渲染:右栏 ProjectDock ═══════════ */
  function renderRail() {
    var rail = $('#rail');
    var s = curSession();
    var hide = !state.rail || !!state.cross || state.view !== 'chat';
    $('#app').classList.toggle('no-rail', hide);
    document.documentElement.style.setProperty('--rail-w', state.railW + 'px');
    if (hide) { put(rail, ''); return; }
    if (!s) {
      put(rail, '<div class="dock-head"><div class="dock-tabs"><span class="dock-tab is-active">' + icon('folder', 14) + '文件</span></div>' +
        '<button type="button" class="icon-btn" data-act="rail" aria-label="关闭右栏" title="关闭右栏">' + icon('x', 15) + '</button></div>' +
        '<div class="dock-scroll">' + emptyBlock('还没有会话', '新建会话之后，这里会列出本机工作目录和产出的文件。', '') + '</div>');
      return;
    }
    var files = s.files || [];
    var changes = changesOf(s);
    var dirName = baseName(String(s.mainDir || '').replace(/\/+$/, '')) || 'workspace';
    var head =
      '<button class="rail-resize" type="button" aria-label="拖拽调整右栏宽度" aria-valuemin="260" aria-valuemax="448" aria-valuenow="' + state.railW + '" title="拖拽调整宽度"></button>' +
      '<div class="dock-head">' +
        '<div class="dock-tabs" role="tablist" aria-label="右栏视图">' +
          '<button type="button" role="tab" class="dock-tab ' + (state.dockTab === 'files' ? 'is-active' : '') + '" data-act="dock-tab" data-tab="files" data-focus="dock-files" aria-selected="' + (state.dockTab === 'files') + '">' +
            icon('folder', 14) + '文件</button>' +
          '<button type="button" role="tab" class="dock-tab ' + (state.dockTab === 'changes' ? 'is-active' : '') + '" data-act="dock-tab" data-tab="changes" data-focus="dock-changes" aria-selected="' + (state.dockTab === 'changes') + '">' +
            icon('git', 14) + '变更' + (changes.length ? '<span class="dock-badge">' + changes.length + '</span>' : '') + '</button>' +
        '</div>' +
        '<button type="button" class="icon-btn" data-act="rail" aria-label="关闭右栏" title="关闭右栏">' + icon('x', 15) + '</button>' +
      '</div>';
    put(rail, head + (state.dockTab === 'changes'
      ? '<div class="git-pane">' + gitHtml(s, changes) + '</div>'
      : '<div class="dock-scroll">' + filesHtml(s, files, dirName) + '</div>'));
    syncGitCheckboxes();
    wireRailResize();
    applyFocus();
  }

  function filesHtml(s, files, dirName) {
    var dirsStrip = (s.extraDirs && s.extraDirs.length)
      ? '<div class="rail-dirs" title="本机附加目录列表（点击管理）">' +
          '<span class="rail-dir-pill is-main" title="主目录：' + esc(s.mainDir) + '">' + icon('folder', 11) + esc(dirName) + '</span>' +
          s.extraDirs.map(function (d) { return '<button type="button" class="rail-dir-pill" data-act="dir-menu" title="附加目录：' + esc(d) + '">+' + esc(baseName(d)) + '</button>'; }).join('') +
        '</div>'
      : '';
    var bar = '<div class="dock-bar"><span class="db-name" title="' + esc(s.mainDir) + '">' + esc(dirName) + '</span>' +
      '<button type="button" class="icon-btn" data-act="dock-refresh" aria-label="刷新文件状态" title="刷新">' + icon('refresh', 14) + '</button></div>' + dirsStrip;
    if (!files.length) {
      return bar + '<p class="meta" style="line-height:1.7">这个会话还没有产出文件。</p>';
    }
    var rows = flattenTree(buildTree(files), 0, []);
    return bar +
      '<div class="dock-tree" role="tree" aria-label="' + esc(dirName) + ' 文件树" id="dockTree">' +
        rows.map(function (r, i) {
          if (r.kind === 'dir') {
            return '<button type="button" class="tree-row" role="treeitem" aria-level="' + (r.depth + 1) + '"' +
              ' aria-expanded="' + (r.open ? 'true' : 'false') + '" data-act="tree-toggle" data-dir="' + esc(r.path) + '"' +
              ' data-idx="' + i + '" tabindex="' + (i === 0 ? '0' : '-1') + '" style="--depth:' + r.depth + '">' +
              '<span class="tree-caret' + (r.open ? ' is-open' : '') + '">' + icon('chev-right', 12) + '</span>' +
              icon('folder', 13) + '<span class="tree-name">' + esc(r.name) + '</span></button>';
          }
          var f = r.file || {};
          var on = !!(state.preview && state.preview.active === r.path);
          return '<button type="button" class="tree-row' + (on ? ' is-active' : '') + '" role="treeitem" aria-level="' + (r.depth + 1) + '"' +
            ' aria-selected="' + (on ? 'true' : 'false') + '" data-act="file-open" data-file="' + esc(r.path) + '"' +
            ' data-idx="' + i + '" tabindex="-1" style="--depth:' + r.depth + '" title="' + esc(r.path) + '">' +
            '<span class="tree-caret is-leaf"></span>' + icon('file', 13) +
            '<span class="tree-name">' + esc(r.name) + '</span>' +
            (f.st ? '<span class="f-badge ' + stClass(f.st) + '">' + f.st + '</span>' : '') +
            (f.t ? '<span class="f-time">' + esc(f.t) + '</span>' : '') + '</button>';
        }).join('') +
      '</div>' +
      '<div class="rail-block" style="margin-top:12px"><span class="rail-title">会话</span>' +
        '<div class="dir-line" style="color:var(--meta)">' + icon('clock', 12) + '<span class="d">最近更新 ' + esc(s.time) + '</span></div>' +
        '<div class="dir-line" style="color:var(--meta)">' + icon('lock', 12) + '<span class="d">本机可执行</span></div></div>';
  }

  function gitResolvedView(changes) {
    if (state.gitView === 'tree' || state.gitView === 'list') return state.gitView;
    return changes.length > 6 ? 'tree' : 'list';
  }
  function gitFilteredChanges(changes) {
    var q = (state.gitQ || '').trim().toLowerCase();
    return changes.filter(function (f) {
      if (state.gitFilterSt !== 'all' && f.st !== state.gitFilterSt) return false;
      if (q && f.n.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function gitFilteredLogs(logs) {
    var q = (state.gitLogQ || '').trim().toLowerCase();
    return logs.filter(function (c) {
      if (state.gitLogScope === 'ahead' && !c.ahead) return false;
      if (!q) return true;
      var hitFiles = (c.files || []).some(function (cf) { return cf.n.toLowerCase().indexOf(q) >= 0; });
      return c.msg.toLowerCase().indexOf(q) >= 0 || c.sha.toLowerCase().indexOf(q) >= 0 || c.author.toLowerCase().indexOf(q) >= 0 || hitFiles;
    });
  }
  function gitSelBarHtml(changes, filtered) {
    if (!changes.length) return '';
    var selCount = changes.filter(function (f) { return state.gitSel[f.n]; }).length;
    var allSel = filtered.length > 0 && filtered.every(function (f) { return state.gitSel[f.n]; });
    return '<div class="git-sel" id="gitSelBarMount">' +
      '<label class="od-row" style="--od-gap:6px;cursor:pointer">' +
        '<input type="checkbox" id="gitAllChk" data-act="git-all" aria-label="全选当前变更文件"' + (allSel ? ' checked' : '') + '>' +
        '<span>' + (filtered.length === changes.length ? '全选' : '全选筛选结果') + '</span></label>' +
      '<span class="gs-count" style="margin-left:auto">已选 ' + selCount + ' / ' + changes.length + '</span>' +
      (selCount ? '<button type="button" class="git-sel-clear" data-act="git-sel-clear">清空</button>' : '') +
    '</div>';
  }
  function gitChangesListHtml(changes, filtered) {
    if (!changes.length) return '<p class="meta" style="line-height:1.7;padding:6px 4px">工作区与 HEAD 一致，没有未提交变更。</p>';
    if (!filtered.length) return '<p class="meta" style="line-height:1.7;padding:8px 4px">没有匹配当前筛选条件的文件。</p>';
    var mode = gitResolvedView(changes);
    if (mode === 'tree') {
      var tree = compressTreeNode(buildTree(filtered));
      var rows = flattenTree(tree, 0, [], state.gitDirOpen);
      var showStatInTree = state.railW >= 340;
      return '<div class="git-tree" id="gitTree" role="tree" aria-label="变更文件目录树">' +
        rows.map(function (r, idx) {
          var ti = idx === 0 ? '0' : '-1';
          if (r.kind === 'dir') {
            var allChecked = r.allPaths.length > 0 && r.allPaths.every(function (p) { return !!state.gitSel[p]; });
            return '<div class="gt-row" role="treeitem" aria-level="' + (r.depth + 1) + '" aria-expanded="' + (r.open ? 'true' : 'false') + '" style="--depth:' + r.depth + '">' +
              '<button type="button" class="gt-caret' + (r.open ? ' is-open' : '') + '" tabindex="-1" data-act="git-dir-toggle" data-dir="' + esc(r.path) + '" aria-label="' + (r.open ? '折叠 ' : '展开 ') + esc(r.name) + '">' + icon('chev-right', 12) + '</button>' +
              '<label class="gt-chk"><input type="checkbox" tabindex="-1" data-act="git-dir-sel" data-paths="' + esc(r.allPaths.join('\n')) + '" aria-label="选择目录 ' + esc(r.name) + '"' + (allChecked ? ' checked' : '') + '></label>' +
              '<button type="button" class="gt-btn" data-tree-nav="1" data-act="git-dir-toggle" data-dir="' + esc(r.path) + '" tabindex="' + ti + '" title="' + esc(r.path) + '（' + r.allPaths.length + ' 个文件）">' +
                icon('folder', 13) + '<span class="gt-name gt-dir-name">' + esc(r.name) + '</span>' +
                '<span class="gt-dir-count">' + r.allPaths.length + '</span>' +
              '</button>' +
            '</div>';
          }
          var f = r.file || {};
          var active = !!(state.preview && state.preview.active === r.path);
          var statTitle = (f.add || f.del) ? ('（+' + (f.add || 0) + ' -' + (f.del || 0) + '）') : '';
          return '<div class="gt-row' + (active ? ' is-active' : '') + '" role="treeitem" aria-level="' + (r.depth + 1) + '" aria-selected="' + (active ? 'true' : 'false') + '" style="--depth:' + r.depth + '">' +
            '<span class="gt-caret is-leaf"></span>' +
            '<label class="gt-chk"><input type="checkbox" tabindex="-1" data-act="git-toggle" data-file="' + esc(r.path) + '" aria-label="选择 ' + esc(r.name) + '"' + (state.gitSel[r.path] ? ' checked' : '') + '></label>' +
            '<button type="button" class="gt-btn" data-tree-nav="1" data-act="file-open" data-file="' + esc(r.path) + '" data-diff="1" tabindex="' + ti + '" title="对比工作区与 HEAD：' + esc(r.path) + statTitle + '">' +
              '<span class="gt-name">' + esc(r.name) + '</span>' +
              (showStatInTree && (f.add || f.del) ? '<span class="git-diffstat">' + (f.add ? '<span class="ds-a">+' + f.add + '</span>' : '') + (f.del ? '<span class="ds-d">-' + f.del + '</span>' : '') + '</span>' : '') +
              '<span class="git-st ' + stClass(f.st) + '">' + f.st + '</span>' +
            '</button>' +
          '</div>';
        }).join('') +
      '</div>';
    }
    return '<div class="git-list">' +
      filtered.map(function (f) {
        var active = !!(state.preview && state.preview.active === f.n);
        return '<div class="git-row' + (active ? ' is-active' : '') + '">' +
          '<label class="gt-chk"><input type="checkbox" data-act="git-toggle" data-file="' + esc(f.n) + '" aria-label="选择 ' + esc(baseName(f.n)) + '"' + (state.gitSel[f.n] ? ' checked' : '') + '></label>' +
          '<button type="button" class="g-body" data-act="file-open" data-file="' + esc(f.n) + '" data-diff="1" title="对比工作区与 HEAD：' + esc(f.n) + '"' +
            ' style="border:none;background:transparent;padding:0;text-align:left;color:inherit">' +
            '<span class="g-name">' + esc(baseName(f.n)) + '</span>' +
            '<span class="g-path">' + esc(f.n) + '</span>' +
          '</button>' +
          (f.add || f.del ? '<span class="git-diffstat">' + (f.add ? '<span class="ds-a">+' + f.add + '</span>' : '') + (f.del ? '<span class="ds-d">-' + f.del + '</span>' : '') + '</span>' : '') +
          '<span class="git-st ' + stClass(f.st) + '">' + f.st + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }
  function gitLogsListHtml(logs, filtered, branch) {
    if (!logs.length) return '<p class="meta" style="line-height:1.7;padding:6px 4px">暂无提交记录。</p>';
    if (!filtered.length) return '<p class="meta" style="line-height:1.7;padding:8px 4px">没有匹配当前过滤条件的提交。</p>';
    var visible = filtered.slice(0, state.gitLogLimit || 8);
    var hasMore = filtered.length > visible.length;
    var items = [];
    var insertedBaseline = false;
    visible.forEach(function (c, idx) {
      if (!insertedBaseline && idx > 0 && visible[idx - 1].ahead && !c.ahead) {
        insertedBaseline = true;
        items.push('<div class="git-baseline" role="separator"><span>以上待推送 · origin/' + esc(branch) + '</span></div>');
      }
      var isOpen = state.openCommit === c.sha;
      var files = c.files || [];
      var showAll = !!state.openCommitAll[c.sha];
      var cap = 6;
      var shownFiles = showAll ? files : files.slice(0, cap);
      var hiddenCount = files.length - shownFiles.length;
      var filesHtmlBlock = isOpen && files.length
        ? '<div class="gl-files">' +
            shownFiles.map(function (cf) {
              var fn = baseName(cf.n);
              var dir = cf.n.slice(0, Math.max(0, cf.n.length - fn.length)).replace(/\/+$/, '');
              var active = !!(state.preview && state.preview.active === cf.n && state.ptab === 'diff');
              return '<button type="button" class="gl-file' + (active ? ' is-active' : '') + '" data-act="file-open" data-file="' + esc(cf.n) + '" data-diff="1" title="' + esc(cf.n) + '">' +
                icon('file', 12) +
                '<span class="gl-fn">' + esc(fn) + '</span>' +
                (dir ? '<span class="gl-fp">' + esc(dir) + '</span>' : '<span class="gl-fp"></span>') +
                '<span class="git-st ' + stClass(cf.st) + '">' + cf.st + '</span></button>';
            }).join('') +
            (hiddenCount > 0 ? '<button type="button" class="gl-more" data-act="git-commit-all" data-sha="' + esc(c.sha) + '">展开全部 ' + files.length + ' 个文件（还有 ' + hiddenCount + ' 个）</button>' : '') +
          '</div>'
        : '';
      var cls = 'gl-item' + (idx === 0 ? ' is-first' : '') + (idx === visible.length - 1 ? ' is-last' : '') + (c.ahead ? ' is-ahead' : '');
      items.push('<div class="' + cls + '">' +
        '<button type="button" class="gl-btn' + (isOpen ? ' is-open' : '') + '" data-act="git-commit-toggle" data-sha="' + esc(c.sha) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
          '<span class="gl-dot" aria-hidden="true"></span>' +
          '<span class="gl-main">' +
            '<span class="gl-msg">' + esc(c.msg) + '</span>' +
            '<span class="gl-meta"><span class="gl-sha">' + esc(c.sha) + '</span>' +
              (c.head ? '<span class="gl-head-tag">HEAD</span>' : '') +
              '<span>' + esc(c.author) + '</span><span>·</span><span>' + esc(c.time) + '</span>' +
              '<span style="margin-left:auto">' + files.length + ' 个文件</span>' +
            '</span>' +
          '</span>' +
        '</button>' + filesHtmlBlock +
      '</div>');
    });
    return '<div class="git-log">' + items.join('') + '</div>' +
      (hasMore ? '<button type="button" class="git-log-more" data-act="git-log-more">加载更早提交（剩余 ' + (filtered.length - visible.length) + ' 条）</button>' : '');
  }
  function syncGitCheckboxes() {
    var s = curSession();
    if (!s) return;
    var changes = changesOf(s);
    var filtered = gitFilteredChanges(changes);
    var allChk = document.getElementById('gitAllChk');
    if (allChk) {
      var selInFiltered = filtered.filter(function (f) { return !!state.gitSel[f.n]; }).length;
      allChk.checked = filtered.length > 0 && selInFiltered === filtered.length;
      allChk.indeterminate = selInFiltered > 0 && selInFiltered < filtered.length;
    }
    $$('#rail input[data-act="git-dir-sel"]').forEach(function (inp) {
      var raw = inp.getAttribute('data-paths') || '';
      var paths = raw ? raw.split('\n') : [];
      var hit = paths.filter(function (p) { return !!state.gitSel[p]; }).length;
      inp.checked = paths.length > 0 && hit === paths.length;
      inp.indeterminate = hit > 0 && hit < paths.length;
    });
  }
  function refreshGitList() {
    var s = curSession();
    var mount = document.getElementById('gitReviewMount');
    var selMount = document.getElementById('gitSelWrapMount');
    var clr = document.querySelector('[data-act="git-q-clear"]');
    if (clr) clr.hidden = !state.gitQ;
    if (!s || !mount) return;
    var changes = changesOf(s);
    var filtered = gitFilteredChanges(changes);
    if (selMount) put(selMount, gitSelBarHtml(changes, filtered));
    put(mount, gitChangesListHtml(changes, filtered));
    syncGitCheckboxes();
  }
  function refreshGitLog() {
    var s = curSession();
    var mount = document.getElementById('gitReviewMount');
    var clr = document.querySelector('[data-act="git-log-q-clear"]');
    if (clr) clr.hidden = !state.gitLogQ;
    if (!s || !mount) return;
    var branch = s.branch || ('feat/' + (baseName(s.mainDir) || 'work'));
    var logs = gitLogOf(s);
    var filtered = gitFilteredLogs(logs);
    put(mount, gitLogsListHtml(logs, filtered, branch));
  }

  function gitHtml(s, changes) {
    var branch = s.branch || ('feat/' + (baseName(s.mainDir) || 'work'));
    var logs = gitLogOf(s);
    var ahead = gitAheadCount(logs);
    var isHistory = state.gitSub === 'history';

    var top = '<div class="git-top">' +
      '<div class="git-head">' +
        '<span class="git-branch" title="当前分支：' + esc(branch) + '">' + icon('git', 13) + '<span class="gb-name">' + esc(branch) + '</span></span>' +
        '<span class="git-ahead" title="领先远端 ' + ahead + ' 个提交">↑' + ahead + '</span>' +
        '<button type="button" class="git-stress-btn' + (state.gitStress ? ' is-on' : '') + '" data-act="git-stress" aria-pressed="' + (state.gitStress ? 'true' : 'false') + '" title="切换常规示例与大规模多文件/多提交示例">' +
          (state.gitStress ? '恢复常规' : '22文件压测') + '</button>' +
        '<button type="button" class="icon-btn" data-act="dock-refresh" aria-label="刷新变更与日志" title="刷新">' + icon('refresh', 14) + '</button>' +
      '</div>' +
      '<div class="seg git-seg" role="tablist" aria-label="变更面板子视图">' +
        '<button type="button" role="tab" class="' + (!isHistory ? 'is-active' : '') + '" data-act="git-sub" data-sub="changes" data-focus="git-sub-changes" aria-selected="' + (!isHistory) + '">' +
          '<span>工作区</span><span class="gs-pill">' + changes.length + '</span></button>' +
        '<button type="button" role="tab" class="' + (isHistory ? 'is-active' : '') + '" data-act="git-sub" data-sub="history" data-focus="git-sub-history" aria-selected="' + (isHistory) + '">' +
          '<span>提交记录</span><span class="gs-pill">' + (ahead ? ('↑' + ahead) : logs.length) + '</span></button>' +
      '</div>';

    if (!isHistory) {
      var filtered = gitFilteredChanges(changes);
      var viewMode = gitResolvedView(changes);
      var counts = { all: changes.length, M: 0, A: 0, U: 0 };
      changes.forEach(function (f) { if (counts[f.st] !== undefined) counts[f.st]++; });
      top += '<div class="git-toolbar">' +
        '<div class="git-search-row">' +
          '<div class="git-search-box">' + icon('search', 13) +
            '<input type="text" id="gitQInput" data-role="git-q" value="' + esc(state.gitQ) + '" placeholder="筛选文件路径…" aria-label="筛选变更文件">' +
            '<button type="button" class="git-search-clear" data-act="git-q-clear" aria-label="清空筛选"' + (state.gitQ ? '' : ' hidden') + '>' + icon('x', 12) + '</button>' +
          '</div>' +
          '<div class="git-view-seg" role="group" aria-label="变更展示方式">' +
            '<button type="button" class="git-view-btn' + (viewMode === 'tree' ? ' is-active' : '') + '" data-act="git-view" data-view="tree" aria-label="目录树视图" title="目录树（按目录分组）">' + icon('tree', 13) + '</button>' +
            '<button type="button" class="git-view-btn' + (viewMode === 'list' ? ' is-active' : '') + '" data-act="git-view" data-view="list" aria-label="平铺列表视图" title="平铺列表">' + icon('list', 13) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="git-chip-row" role="group" aria-label="按变更类型筛选">' +
          [['all', '全部'], ['M', 'M 修改'], ['A', 'A 新增'], ['U', 'U 未跟踪']].map(function (item) {
            var k = item[0], lbl = item[1];
            return '<button type="button" class="git-chip' + (state.gitFilterSt === k ? ' is-active' : '') + '" data-act="git-st" data-st="' + k + '">' +
              lbl + ' ' + counts[k] + '</button>';
          }).join('') +
        '</div>' +
      '</div></div>' +
      '<div id="gitSelWrapMount">' + gitSelBarHtml(changes, filtered) + '</div>' +
      '<div class="git-review" id="gitReviewMount">' + gitChangesListHtml(changes, filtered) + '</div>' +
      '<div class="git-hist-foot">' + icon('lock', 12) +
        '<span class="od-truncate">只读变更视图 · 提交与推送入口暂缓</span></div>';
      return top;
    }

    var filteredLogs = gitFilteredLogs(logs);
    top += '<div class="git-toolbar">' +
      '<div class="git-search-box">' + icon('search', 13) +
        '<input type="text" id="gitLogQInput" data-role="git-log-q" value="' + esc(state.gitLogQ) + '" placeholder="搜索提交信息、Hash、作者…" aria-label="搜索提交记录">' +
        '<button type="button" class="git-search-clear" data-act="git-log-q-clear" aria-label="清空搜索"' + (state.gitLogQ ? '' : ' hidden') + '>' + icon('x', 12) + '</button>' +
      '</div>' +
      '<div class="git-chip-row" role="group" aria-label="提交范围">' +
        '<button type="button" class="git-chip' + (state.gitLogScope === 'all' ? ' is-active' : '') + '" data-act="git-log-scope" data-scope="all">全部 ' + logs.length + '</button>' +
        '<button type="button" class="git-chip' + (state.gitLogScope === 'ahead' ? ' is-active' : '') + '" data-act="git-log-scope" data-scope="ahead">仅未推送 ↑' + ahead + '</button>' +
      '</div>' +
    '</div></div>' +
    '<div class="git-review" id="gitReviewMount">' + gitLogsListHtml(logs, filteredLogs, branch) + '</div>' +
    '<div class="git-hist-foot">' +
      icon('git', 12) +
      '<span class="gh-branch">origin/' + esc(branch) + '</span>' +
      '<span>' + (ahead ? ('领先 ' + ahead + ' 个提交') : '已同步') + '</span>' +
    '</div>';
    return top;
  }

  function wireRailResize() {
    var h = $('#rail .rail-resize');
    if (!h) return;
    h.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
      var startX = e.clientX, startW = state.railW, moved = false;
      h.classList.add('is-drag');
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* 不支持指针捕获时仍可拖 */ }
      function move(ev) {
        if (Math.abs(ev.clientX - startX) >= 3) moved = true;
        var w = Math.round(Math.min(448, Math.max(260, startW - (ev.clientX - startX) / z)));
        state.railW = w;
        document.documentElement.style.setProperty('--rail-w', w + 'px');
        h.setAttribute('aria-valuenow', w);
      }
      function up() {
        h.classList.remove('is-drag');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        if (moved && state.railW !== startW) {
          if (state.dockTab === 'changes') refreshGitList();
          toast('右栏宽度 ' + state.railW + 'px 已保存');
        }
      }
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    h.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowLeft' ? 16 : (e.key === 'ArrowRight' ? -16 : 0);
      if (!d) return;
      e.preventDefault();
      state.railW = Math.round(Math.min(448, Math.max(260, state.railW + d)));
      document.documentElement.style.setProperty('--rail-w', state.railW + 'px');
      h.setAttribute('aria-valuenow', state.railW);
    });
  }

  /* 目录树键盘导航:上下移动、左右展开收起(#dockTree 与 #gitTree 共用) */
  document.addEventListener('keydown', function (e) {
    var tree = e.target.closest && e.target.closest('#dockTree, #gitTree');
    if (!tree) return;
    var isGit = tree.id === 'gitTree';
    var rowSel = isGit ? '.gt-btn[data-tree-nav="1"]' : '.tree-row';
    var row = e.target.closest(rowSel);
    if (!row) return;
    var rows = $$(rowSel, tree);
    var i = rows.indexOf(row);
    function focusRow(n) {
      var t = rows[n];
      if (!t) return;
      rows.forEach(function (r) { r.tabIndex = -1; });
      t.tabIndex = 0;
      t.focus();
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(Math.max(0, i - 1)); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      var dirR = row.getAttribute('data-dir');
      var itemR = isGit ? row.closest('.gt-row') : row;
      if (dirR && itemR && itemR.getAttribute('aria-expanded') === 'false') { row.click(); return; }
      focusRow(Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      var dirL = row.getAttribute('data-dir');
      var itemL = isGit ? row.closest('.gt-row') : row;
      if (dirL && itemL && itemL.getAttribute('aria-expanded') === 'true') { row.click(); return; }
      var depth = Number((itemL && itemL.style.getPropertyValue('--depth')) || 0);
      for (var k = i - 1; k >= 0; k--) {
        var pk = isGit ? rows[k].closest('.gt-row') : rows[k];
        if (Number((pk && pk.style.getPropertyValue('--depth')) || 0) < depth) { focusRow(k); return; }
      }
    } else if (isGit && e.key === ' ') {
      var chk = row.closest('.gt-row') && row.closest('.gt-row').querySelector('input[type="checkbox"]');
      if (chk) { e.preventDefault(); chk.click(); }
    }
  });

  /* ═══════════ 菜单 / 弹层 ═══════════ */
  var menuOpener = null;
  var popOpener = null;
  var palOpener = null;

  function openMenu(kind, anchor) {
    var menu = $('#menu');
    menuOpener = anchor || document.activeElement;
    var html = '';
    if (kind === 'ws') {
      html = '<div class="menu-label">Workspace</div>' + WORKSPACES.filter(function (w) { return teamRole(w.id, ME); }).map(function (w) {
        var on = w.id === state.ws;
        return '<button type="button" role="menuitem" class="menu-item" data-act="pick-ws" data-id="' + w.id + '">' +
          '<span class="av-stack">' + w.members.slice(0, 3).map(function (m) { return av(m, 20); }).join('') + '</span>' +
          '<span class="mi-main"><span class="mi-name">' + esc(w.name) + '</span>' +
          '<span class="mi-sub">' + w.members.length + ' 人 · ' + state.projects.filter(function (p) { return p.ws === w.id; }).length + ' 个 Project</span></span>' +
          (on ? '<span class="mi-check">' + icon('check', 14) + '</span>' : '') + '</button>';
      }).join('') +
      '<div class="menu-sep"></div>' +
      '<button type="button" role="menuitem" class="menu-item" data-act="roles">' + icon('shield', 15) + '<span>成员与角色管理</span></button>';
    } else if (kind === 'sess') {
      var sopts = [{ id: 'all', name: '全部会话', sub: '跨所有团队' }]
        .concat(WORKSPACES.filter(function (w) { return teamRole(w.id, ME); }).map(function (w) {
          return { id: w.id, name: w.name, sub: w.members.length + ' 人' };
        }))
        .concat([{ id: 'none', name: '无团队', sub: '仅本机个人会话' }]);
      html = '<div class="menu-label">按团队筛选</div>' + sopts.map(function (o) {
        var on = state.sessFilter === o.id;
        return '<button type="button" role="menuitem" class="menu-item" data-act="sess-filter" data-id="' + o.id + '">' +
          '<span class="mi-main"><span class="mi-name">' + esc(o.name) + '</span>' +
          '<span class="mi-sub">' + esc(o.sub) + '</span></span>' +
          (on ? '<span class="mi-check">' + icon('check', 14) + '</span>' : '') + '</button>';
      }).join('');
    } else if (kind === 'team') {
      var cs = curSession();
      var topts = WORKSPACES.filter(function (w) { return teamRole(w.id, ME); }).map(function (w) {
        return { id: w.id, name: w.name };
      }).concat([{ id: 'none', name: '无团队' }]);
      html = '<div class="menu-label">团队上下文 · 发出首条消息后锁定</div>' + topts.map(function (o) {
        var cur = cs && (cs.team || 'none') === o.id;
        return '<button type="button" role="menuitem" class="menu-item" data-act="team-pick" data-id="' + o.id + '">' +
          '<span class="mi-main"><span class="mi-name">' + esc(o.name) + '</span></span>' +
          (cur ? '<span class="mi-check">' + icon('check', 14) + '</span>' : '') + '</button>';
      }).join('');
    } else {
      var list = wsProjects();
      html = '<div class="menu-label">Project</div>' + list.map(function (p) {
        var on = p.id === state.proj;
        return '<button type="button" role="menuitem" class="menu-item" data-act="pick-proj" data-id="' + p.id + '">' +
          '<span class="mi-main"><span class="mi-name">' + esc(p.name) + '</span>' +
          '<span class="mi-sub">' + p.members.length + ' 人' + (p.repo ? ' · ' + esc(p.repo) : '') + '</span></span>' +
          (on ? '<span class="mi-check">' + icon('check', 14) + '</span>' : '') + '</button>';
      }).join('') +
      '<div class="menu-sep"></div>' +
      '<button type="button" role="menuitem" class="menu-item" data-act="new-project">' + icon('plus', 15) + '<span class="mi-main"><span class="mi-name">新建 Project</span></span></button>';
    }
    put(menu, html);
    menu.hidden = false;
    menu.dataset.kind = kind;
    var r = anchor.getBoundingClientRect();
    menu.style.left = Math.round(Math.max(8, r.left)) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    if (kind === 'dir') anchor.classList.add('is-open');
    var first = menu.querySelector('.menu-item');
    if (first) first.focus();
  }
  function closeMenu(restoreFocus) {
    var m = $('#menu');
    if (m.hidden) return;
    m.hidden = true;
    $$('[data-act="ws-menu"], [data-act="proj-menu"], [data-act="sess-menu"], [data-act="team-menu"]').forEach(function (el) { el.setAttribute('aria-expanded', 'false'); });
    var db = $('.tb-dir');
    if (db) { db.setAttribute('aria-expanded', 'false'); db.classList.remove('is-open'); }
    if (restoreFocus && menuOpener && menuOpener.isConnected) menuOpener.focus();
    menuOpener = null;
  }

  function openPopover(owner) {
    popOpener = document.activeElement;
    state.pop.owner = owner || 'all';
    state.pop.q = '';
    state.pop.filter = 'all';
    var pop = $('#popover');
    pop.hidden = false;
    pop.style.top = Math.round(48 * state.zoom + 6) + 'px';
    pop.style.right = '16px';
    pop.style.left = 'auto';
    var btn = $('.collab-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    renderPopover();
    var input = pop.querySelector('[data-role="pop-q"]');
    if (input) input.focus();
  }
  function closePopover(restoreFocus) {
    var pop = $('#popover');
    if (pop.hidden) return;
    pop.hidden = true;
    var btn = $('.collab-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (restoreFocus && popOpener && popOpener.isConnected) popOpener.focus();
    popOpener = null;
  }

  function renderPopover() {
    var pop = $('#popover');
    if (pop.hidden) return;
    var proj = curProj();
    var q = state.pop.q.trim().toLowerCase();
    var mates = teammates().filter(function (m) {
      if (!q) return true;
      if (PEOPLE[m].name.toLowerCase().indexOf(q) >= 0) return true;
      return peersOf(state.proj).some(function (p) { return p.owner === m && p.title.toLowerCase().indexOf(q) >= 0; });
    });

    var memberRows =
      '<button type="button" class="pop-member ' + (state.pop.owner === 'all' ? 'is-active' : '') + '" data-act="pop-member" data-owner="all" data-focus="pop-m-all">' +
        '<span class="pm-body" style="padding-left:4px"><span class="pm-name">全部成员</span>' +
        '<span class="pm-role">' + proj.members.length + ' 人 · 本项目</span></span></button>' +
      (mates.length ? mates.map(function (m) {
        var on = state.pop.owner === m;
        return '<button type="button" class="pop-member ' + (on ? 'is-active' : '') + '" data-act="pop-member" data-owner="' + m + '" data-focus="pop-m-' + m + '">' +
          av(m, 24) +
          '<span class="pm-body"><span class="pm-name">' + esc(PEOPLE[m].name) +
            (hasUpdate(m) ? '<span class="pm-dot" aria-hidden="true"></span>' : '') + '</span>' +
          '<span class="pm-role">' + esc(PEOPLE[m].role) + '</span></span></button>';
      }).join('') : '<span class="pop-empty" style="padding:10px 8px">没有匹配的成员</span>');

    var filters = [
      { id: 'all', label: '全部' },
      { id: 'updated', label: '有更新' },
      { id: 'unsynced', label: '未同步' }
    ];

    put(pop,
      '<div class="pop-head">' +
        '<div class="od-row" style="--od-gap:6px">' +
          '<span style="font-size:var(--text-sm);font-weight:600;color:var(--fg)">' + esc(proj.name) + ' · 协作成员</span>' +
          '<span class="meta od-nowrap" style="margin-left:auto" id="popCount">' + popItems().length + ' 条</span>' +
          '<button type="button" class="icon-btn" data-act="pop-close" aria-label="关闭">' + icon('x', 15) + '</button>' +
        '</div>' +
        '<div class="pop-search">' + icon('search', 14) +
          '<label class="sr" for="popQ">搜索成员或会话</label>' +
          '<input id="popQ" data-role="pop-q" type="text" placeholder="搜成员姓名或会话标题" value="' + esc(state.pop.q) + '" autocomplete="off">' +
        '</div>' +
      '</div>' +
      '<div class="pop-body">' +
        '<div class="pop-members" role="group" aria-label="按成员筛选">' +
          '<span class="pop-members-label">成员</span>' + memberRows +
        '</div>' +
        '<div class="pop-main">' +
          '<div class="pop-filters"><div class="seg" role="tablist" aria-label="按同步状态筛选">' + filters.map(function (f) {
            return '<button type="button" role="tab" class="' + (state.pop.filter === f.id ? 'is-active' : '') + '" data-act="pop-filter" data-filter="' + f.id + '" data-focus="pop-f-' + f.id + '"' +
              ' aria-selected="' + (state.pop.filter === f.id) + '">' + f.label + '</button>';
          }).join('') + '</div></div>' +
          '<div class="pop-list" id="popList">' + popListHtml() + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pop-foot">' + icon('lock', 12) + '会话同步是 Project 维度的，拿到的都是只读快照</div>');
    applyFocus();
  }

  function popItems() {
    var q = state.pop.q.trim().toLowerCase();
    return peersOf(state.proj).filter(function (p) {
      if (state.pop.owner !== 'all' && p.owner !== state.pop.owner) return false;
      if (state.pop.filter !== 'all' && p.sync !== state.pop.filter) return false;
      if (!q) return true;
      var hay = (p.title + ' ' + PEOPLE[p.owner].name).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function popListHtml() {
    var items = popItems();
    if (!items.length) {
      return '<div class="pop-empty">没有匹配的会话。<br>换个关键词，或者把筛选切回「全部」。</div>';
    }
    return items.map(function (p) {
      return '<button type="button" class="pop-item" data-act="pop-open" data-owner="' + p.owner + '" data-id="' + p.id + '">' +
        av(p.owner, 28) +
        '<span class="pi-main"><span class="pi-title">' + esc(p.title) + '</span>' +
        '<span class="pi-meta">' + esc(PEOPLE[p.owner].name) + ' · ' + esc(p.time) + '</span></span>' +
        '<span class="pi-side"><span class="sync-mark ' + p.sync + '">' +
          (p.sync === 'updated' ? '<span class="d" aria-hidden="true"></span>' : '') +
          SYNC_TEXT[p.sync] + '</span></span></button>';
    }).join('');
  }

  function refreshPopList() {
    var el = $('#popList');
    if (el) put(el, popListHtml());
    var c = $('#popCount');
    if (c) c.textContent = popItems().length + ' 条';
  }

  /* ═══════════ 命令面板 ═══════════ */
  function openPalette() {
    palOpener = document.activeElement;
    var wrap = $('#palette');
    wrap.hidden = false;
    $('#app').inert = true;
    state.palQ = '';
    state.palIdx = 0;
    put(wrap, '<div class="palette" role="dialog" aria-modal="true" aria-label="全局搜索">' +
        '<div class="palette-input">' + icon('search', 16) +
          '<label class="sr" for="palQ">全局搜索</label>' +
          '<input id="palQ" data-role="palette-q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="palList" placeholder="搜索会话、任务、知识" autocomplete="off">' +
          '<span class="kbd">Esc</span></div>' +
        '<div class="palette-list" id="palList" role="listbox" aria-label="搜索结果">' + paletteListHtml() + '</div>' +
      '</div>');
    var input = $('#palQ');
    if (input) input.focus();
  }
  function closePalette(restoreFocus) {
    var wrap = $('#palette');
    if (wrap.hidden) return;
    wrap.hidden = true;
    $('#app').inert = false;
    put(wrap, '');
    if (restoreFocus && palOpener && palOpener.isConnected) palOpener.focus();
    palOpener = null;
  }

  function paletteListHtml() {
    var q = state.palQ.trim().toLowerCase();
    function hit(text) { return !q || String(text).toLowerCase().indexOf(q) >= 0; }
    var groups = [];
    var cap = q ? 99 : 3;

    var mine = mySessions().filter(function (s) { return hit(s.title); });
    mine = mine.slice(0, cap);
    if (mine.length) {
      groups.push({ label: '我的会话', items: mine.map(function (s) {
        return { act: 'session', id: s.id, t: s.title, s: wsById(s.team).name + ' · ' + visibility(s), av: ME };
      }) });
    }
    var pe = state.projects.flatMap(function (p) { return peersOf(p.id); })
      .filter(function (p) { return (q || p.proj === state.proj) && (hit(p.title) || hit(PEOPLE[p.owner].name)); })
      .slice(0, cap);
    if (pe.length) {
      groups.push({ label: '队友会话（只读）', items: pe.map(function (p) {
        return { act: 'pop-open', owner: p.owner, id: p.id, t: p.title, s: PEOPLE[p.owner].name + ' · ' + projById(p.proj).name, av: p.owner };
      }) });
    }
    var tk = state.tasks
      .filter(function (t) { return projectAccess(projById(t.proj)) && (q || t.proj === state.proj) && hit(t.title); })
      .slice(0, cap);
    if (tk.length) {
      groups.push({ label: '任务', items: tk.map(function (t) {
        return { act: 'task-jump', id: t.id, t: t.title, s: projById(t.proj).name + ' · ' + STATUS_TEXT[t.status], av: t.to };
      }) });
    }
    var kb = state.knowledge
      .filter(function (k) {
        var inCur = k.scope === 'workspace' ? k.ws === state.ws : k.proj === state.proj;
        return teamRole(k.ws, ME) && (q || inCur) && (hit(k.title) || hit(k.sum));
      })
      .slice(0, cap);
    if (kb.length) {
      groups.push({ label: '知识', items: kb.map(function (k) {
        return { act: 'know-jump', id: k.id, ws: k.ws, proj: k.proj || '', t: k.title,
          s: (k.scope === 'workspace' ? 'Workspace 团队' : projById(k.proj).name) + ' · ' + k.version, av: k.author };
      }) });
    }
    if (!groups.length) return '<div class="pop-empty">没有匹配的内容。<br>试试会话标题、成员名或知识关键词。</div>';

    var flatIdx = 0;
    var hint = q ? '' : '<div class="p-hint">输入关键词搜索全部可见记录</div>';
    return hint + groups.map(function (g) {
      return '<div class="p-group">' + g.label + '</div>' + g.items.map(function (it) {
        var hl = flatIdx === state.palIdx;
        flatIdx++;
        return '<button type="button" class="p-item ' + (hl ? 'is-hl' : '') + '" data-act="' + it.act + '" data-id="' + it.id + '"' +
          (it.owner ? ' data-owner="' + it.owner + '"' : '') +
          (it.ws ? ' data-ws="' + it.ws + '"' : '') +
          (it.proj ? ' data-proj="' + it.proj + '"' : '') + '>' +
          av(it.av, 22) + '<span class="p-main"><span class="p-t">' + esc(it.t) + '</span>' +
          '<span class="p-s">' + esc(it.s) + '</span></span></button>';
      }).join('');
    }).join('');
  }

  /* ═══════════ 导航动作 ═══════════ */
  function closeMobileDrawer() {
    state.drawer = false;
    var sb = $('#sidebar'); if (sb) sb.classList.remove('is-open');
    var sc = $('#scrim'); if (sc && !(state.rail && window.innerWidth <= 1040)) sc.hidden = true;
  }
  function goView(v) {
    if (v === 'tasks') { v = 'board'; }
    if (((v === 'knowledge' || v === 'board') && !teamRole(state.ws, ME)) || (v === 'project' && !projectAccess(curProj()))) return;
    closeMenu(); closePopover(); closePalette(); closeMobileDrawer();
    state.cross = null;
    if (v !== 'inbox') state.returnTo = null;
    state.view = v;
    if (v === 'board' || v === 'knowledge' || v === 'project') {
      state.space = 'team';
      if (v === 'board' || v === 'knowledge') { state.lastTeamView = v; state.teamPane = v; if (LAYOUT_MODE === 'A') state.sidePane = v; }
    }
    state.preview = null;
    state.kEdit = false;
    state.projEdit = false;
    render();
  }
  function openSession(id) {
    var s = mySessions().find(function (x) { return x.id === id; });
    if (!s) return;
    state.cross = null;
    state.returnTo = null;
    state.atq = null;
    state.ctxOpen = false;
    state.session = id;
    state.view = 'chat';
    state.preview = null;
    state.shouldScrollEnd = true;
    s.unread = false;
    syncSpaceFor(s);
    if (s.shareProject) state.lastTeamView = 'chat';
    closePopover(); closeMenu(); closePalette(); closeMobileDrawer();
    render();
  }
  function openPeer(owner, id) {
    var p = peerById(id);
    if (!p || p.owner !== owner) return;
    if (!state.cross) {
      state.returnTo = {
        space: state.space, view: state.view, boardScope: state.boardScope, boardView: state.boardView,
        boardProj: state.boardProj, proj: state.proj, session: state.session,
        label: state.view === 'board' ? (state.boardView === 'member' ? '返回成员泳道' : '返回看板')
          : (state.view === 'knowledge' ? '返回团队知识' : (state.view === 'project' ? '返回 Project' : '返回会话'))
      };
    }
    state.proj = p.proj;
    state.ws = projById(p.proj).ws;
    state.cross = { owner: p.owner, id: id };
    state.view = 'chat';
    state.space = 'team';
    if (state.sidePane !== 'inbox') state.sidePane = 'tsessions';
    state.collabOpen[p.proj] = true;
    state.memberOpen[p.proj + ':' + p.owner] = true;
    state.preview = null;
    state.shouldScrollEnd = true;
    closePopover(); closeMenu(); closePalette(); closeMobileDrawer();
    render();
  }
  /* 会话按可见性归属空间:仅本人 → 个人;已发布到 Project → 团队 */
  function syncSpaceFor(s) {
    if (!s) return;
    state.space = s.shareProject ? 'team' : 'personal';
    if (s.shareProject) {
      var sp = projById(s.shareProject);
      if (sp) { state.proj = sp.id; state.ws = sp.ws; state.collabOpen[sp.id] = true; }
      state.teamPane = 'tsessions'; state.lastTeamView = 'chat';
    }
    state.sidePane = s.shareProject ? 'tsessions' : 'sessions';
  }
  function openInbox(tab, key, fromCtx) {
    closeMenu(); closePopover(); closePalette(); closeMobileDrawer();
    if ($('#dlgJourney').open) closeDialog('dlgJourney');
    if (fromCtx && state.view !== 'inbox') {
      state.returnTo = {
        space: state.space, view: state.view, boardScope: state.boardScope, boardView: state.boardView,
        boardProj: state.boardProj, proj: state.proj, session: state.session, kscope: state.kscope,
        label: state.view === 'knowledge' ? (state.kscope === 'map' ? '返回系统地图' : '返回团队知识') : (state.view === 'board' ? '返回看板' : '返回会话')
      };
    } else if (!fromCtx) { state.returnTo = null; }
    state.cross = null; state.view = 'inbox';
    if (LAYOUT_MODE === 'A') state.sidePane = 'inbox';
    state.inboxTab = (tab === 'sent') ? 'sent' : 'todo';
    state.inboxType = 'all';
    if (key) state.inboxSel = key;
    render();
  }
  function setSpace(sp) {
    closeMenu(); closePopover(); closePalette();
    state.space = sp; state.cross = null; state.returnTo = null; state.preview = null;
    if (sp === 'personal') {
      state.sidePane = 'sessions';
      var cs = curSession();
      if (!cs || cs.shareProject) state.session = (privateSessions()[0] || {}).id || null;
      state.view = 'chat'; state.shouldScrollEnd = true;
    } else {
      if (!teamRole(state.ws, ME)) {
        state.sidePane = 'board'; state.view = 'board';
      } else {
        var target = state.lastTeamView || 'board';
        if (target === 'chat') {
          var mine = mySessions().filter(function (s) { return s.shareProject && (!curWs().id || s.team === state.ws); })[0];
          if (mine) { state.session = mine.id; state.view = 'chat'; state.shouldScrollEnd = true; }
          else { state.view = 'board'; state.lastTeamView = 'board'; }
        } else { state.view = target; }
      }
    }
    render();
  }
  function closeTaskDrawer() {
    var dr = $('#stage .t-drawer'), bd = $('#stage .t-drawer-backdrop');
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (dr && !reduced) {
      dr.classList.add('is-closing'); if (bd) bd.classList.add('is-closing');
      setTimeout(function () { state.taskSel = null; render(); }, 115);
    } else { state.taskSel = null; render(); }
  }
  function resolveInboxRowThen(fn) {
    var row = state.view === 'inbox' ? $('#stage .k-side .ib-row.is-active') : null;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (row && !reduced) {
      row.classList.add('is-resolving');
      setTimeout(fn, 150);
    } else { fn(); }
  }
  function switchProject(id) {
    var p = projById(id);
    if (!projectAccess(p)) return;
    state.proj = id;
    state.ws = p.ws;
    state.cross = null;
    state.view = 'board';
    state.boardProj = id;
    state.space = 'team';
    if (state.sidePane !== 'inbox') state.sidePane = 'board';
    state.preview = null;
    state.projEdit = false;
    state.shouldScrollEnd = true;
    closeMenu(); closePopover(); closePalette(); closeMobileDrawer();
    render();
  }

  /* ═══════════ 任务动作 ═══════════ */
  function claimTask(id) {
    var t = taskById(id);
    if (!t || t.to !== ME || t.status !== 'open') return;
    t.status = 'claimed';
    state.focusKey = state.taskSel === id ? ('start-' + id) : ('task-' + id);
    render();
    toast('已接受《' + t.title + '》，已进入「待开始」列');
  }
  function finishTask(id) {
    var t = taskById(id);
    if (!t || t.to !== ME || t.status !== 'running') return;
    t.status = 'done';
    state.focusKey = 'task-' + id;
    render();
    toast('任务已标记完成 · 已通知 ' + PEOPLE[t.from].name);
  }

  function openStartDialog(id) {
    var t = taskById(id);
    if (!t || t.to !== ME || t.status !== 'claimed') return;
    state.startTaskId = id;
    $('#dlgStartSub').textContent = t.title;
    var locals = localSessions();
    var modes = [
      { id: 'existing', label: '用我已经有的本机会话', desc: locals.length ? '在现有会话里继续，工作目录沿用所选会话设置' : '当前 Project 还没有本机会话' },
      { id: 'new', label: '新建一个本机会话', desc: '自己起标题和选工作目录' }
    ];
    put($('#startModeList'), modes.map(function (m) {
      var on = (locals.length === 0 ? 'new' : 'existing') === m.id;
      var dis = m.id === 'existing' && !locals.length;
      return '<label class="choice ' + (on ? 'is-on' : '') + '" data-start-mode="' + m.id + '">' +
        '<input type="radio" name="startMode" value="' + m.id + '"' + (on ? ' checked' : '') + (dis ? ' disabled' : '') + '>' +
        '<span class="c-main"><span class="c-t">' + m.label + '</span><span class="c-d">' + m.desc + '</span></span></label>';
    }).join(''));
    put($('#startPick'), locals.length
      ? locals.map(function (s) {
          var pj = projById(s.shareProject);
          return '<option value="' + s.id + '">' + esc(s.title) + (pj ? '（已发布 · ' + esc(pj.name) + '）' : '（仅本人 · 本机私有）') + '</option>';
        }).join('')
      : '<option value="">暂无本机会话</option>');
    $('#startNewTitle').value = '';
    $('#startNewErr').hidden = true;
    var initMode = locals.length ? 'existing' : 'new';
    syncStartMode(initMode);
    openDialog('dlgStart', locals.length ? '#startPick' : '#startNewTitle');
  }

  function startMode() {
    var on = $('#startModeList').querySelector('input:checked');
    return on ? on.value : 'new';
  }
  function syncStartMode(mode) {
    $$('#startModeList .choice').forEach(function (el) {
      var m = el.getAttribute('data-start-mode');
      el.classList.toggle('is-on', m === mode);
    });
    $('#startPickWrap').hidden = mode !== 'existing';
    $('#startNewWrap').hidden = mode !== 'new';
    var dirInput = $('#startDir');
    if (mode === 'existing') {
      var sid = $('#startPick').value;
      var ex = state.sessions.filter(function (s) { return s.id === sid; })[0];
      dirInput.value = ex ? ex.mainDir : '';
      dirInput.readOnly = true;
    } else {
      var stTask = taskById(state.startTaskId);
      var proj = (stTask && projById(stTask.proj)) || curProj();
      dirInput.readOnly = false;
      dirInput.value = '~/work/harness/' + (proj.repo ? proj.repo.split('/').pop() : 'workspace');
    }
  }

  /* ═══════════ 弹窗 ═══════════ */
  var dlgOpener = null;
  function openDialog(id, focusSel) {
    var d = document.getElementById(id);
    if (!d) return;
    dlgOpener = document.activeElement;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var f = focusSel ? d.querySelector(focusSel) : null;
    if (!f) f = d.querySelector('input[type="text"], input, select, textarea');
    if (f) f.focus();
    if (f && f.select && f.tagName === 'INPUT' && f.type === 'text') { try { f.select(); } catch (e) {} }
  }
  function closeDialog(id) {
    var d = document.getElementById(id);
    if (!d) return;
    if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  }
  document.addEventListener('close', function (e) {
    if (e.target && e.target.tagName === 'DIALOG') {
      var activeDialog = $('dialog[open]');
      var restore = dlgOpener && dlgOpener.isConnected ? dlgOpener : (activeDialog || document).querySelector(activeDialog ? 'button' : '#tbDirBtn, [data-act="new-session"]');
      if (restore && (!activeDialog || activeDialog.contains(restore))) restore.focus();
      dlgOpener = null;
    }
  }, true);

  function openProjectDialog() {
    var ws = curWs();
    $('#dlgProjectSub').textContent = '会创建在「' + ws.name + '」下';
    $('#projName').value = '';
    if ($('#projDesc')) $('#projDesc').value = '';
    $('#projRepo').value = '';
    $('#projNameErr').hidden = true;
    put($('#projMemberList'), ws.members.map(function (m) {
      var p = PEOPLE[m];
      var me = m === ME;
      return '<label class="member-pick chk">' +
        '<input type="checkbox" value="' + m + '"' + (me ? ' checked disabled' : '') + '>' +
        av(m, 22) + '<span class="mp-name">' + esc(p.name) + (me ? ' <span class="meta">(管理员)</span>' : '') + '</span>' +
        '<span class="mp-role">' + esc(p.role) + '</span></label>';
    }).join(''));
    openDialog('dlgProject', '#projName');
  }

  function syncSessPublishRow() {
    var tsEl = $('#sessTeamSel');
    var selWs = tsEl ? (tsEl.value === 'none' ? null : tsEl.value) : state.ws;
    var proj = curProj();
    var matchProj = (proj.id && proj.ws === selWs && projectAccess(proj)) ? proj
      : state.projects.filter(function (p) { return p.ws === selWs && projectAccess(p); })[0];
    $('#sessPublishRow').hidden = !matchProj;
    if (matchProj) $('#sessPublishLabel').textContent = '同时发布到「' + matchProj.name + '」';
    if (!matchProj) $('#sessPublish').checked = false;
  }
  function openSessionDialog(publish) {
    var proj = curProj();
    var myTeams = WORKSPACES.filter(function (w) { return teamRole(w.id, ME); });
    var tsEl = $('#sessTeamSel');
    if (tsEl) {
      put(tsEl, myTeams.map(function (w) { return '<option value="' + w.id + '"' + (w.id === state.ws ? ' selected' : '') + '>' + esc(w.name) + '</option>'; }).join('') +
        '<option value="none"' + (!myTeams.length || !state.ws ? ' selected' : '') + '>无团队（纯本机个人）</option>');
    }
    $('#dlgSessionSub').textContent = '只在本机执行；首条消息发送前可调整团队上下文';
    $('#sessTitle').value = '';
    $('#sessTitleErr').hidden = true;
    $('#sessDir').value = proj.repo ? '~/work/harness/' + baseName(proj.repo) : '~/Documents/local-notes';
    syncSessPublishRow();
    if (!$('#sessPublishRow').hidden) $('#sessPublish').checked = !!publish;
    state.newDirs = [];
    renderNewDirs();
    openDialog('dlgSession', '#sessTitle');
  }

  function openDispatchDialog(owner, src) {
    var cp = curPeer();
    src = src || (cp ? { type: 'peer', title: cp.title, owner: cp.owner, proj: cp.proj } : { type: 'board' });
    var proj = projById(src.proj) || (state.boardProj !== 'all' && projById(state.boardProj)) || curProj();
    if (!projectAccess(proj)) { toast('先选择一个你所在的 Project'); return; }
    src.proj = proj.id;
    state.dispatchSrc = src;
    var first = owner && owner !== ME && owner !== 'all' ? owner : proj.members.filter(function (m) { return m !== ME; })[0];
    $('#dlgDispatchSub').textContent = (src.type === 'board' ? '看板派发' : '从《' + src.title + '》派发') + ' · ' + proj.name + ' · 对方会在 Inbox 里接受或拒绝';
    $('#disTitle').value = '';
    $('#disDesc').value = '';
    $('#disTitleErr').hidden = true;
    put($('#disTo'), proj.members.map(function (m) {
      return '<option value="' + m + '"' + (m === first ? ' selected' : '') + '>' + esc(PEOPLE[m].name) + ' · ' + esc(PEOPLE[m].role) + '</option>';
    }).join(''));
    openDialog('dlgDispatch', '#disTitle');
  }

  function bumpVersion(ver) {
    var m = String(ver || 'v1.0').match(/^v?(\d+)(?:\.(\d+))?$/);
    if (!m) return 'v1.1';
    var maj = parseInt(m[1], 10) || 1;
    var min = m[2] !== undefined ? parseInt(m[2], 10) + 1 : 1;
    return 'v' + maj + '.' + min;
  }

  function updateAtMount() {
    var mount = $('#atMenuMount');
    if (mount) put(mount, state.atq !== null ? atMenuHtml() : '');
  }

  /* ═══════════ 动作分发 ═══════════ */
  function handle(el) {
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    if (handleJourney(act, id, el)) return;

    switch (act) {
      case 'rail-pane': {
        var pn = el.getAttribute('data-pane');
        if (!pn) break;
        state.focusKey = 'rail-' + pn;
        if (!state.side && state.sideFloat && state.sidePane === pn) { state.sideFloat = false; render(); break; }
        if (!state.side) state.sideFloat = true;
        state.sidePane = pn;
        if (pn === 'board' || pn === 'tsessions' || pn === 'knowledge') state.teamPane = pn;
        if (pn === 'inbox') { state.cross = null; state.view = 'inbox'; }
        else if ((pn === 'board' || pn === 'knowledge') && teamRole(state.ws, ME)) { state.cross = null; state.view = pn; state.kEdit = false; }
        render();
        break;
      }
      case 'space': setSpace(id === 'team' ? 'team' : 'personal'); break;
      case 'inbox-tab': state.inboxTab = id; state.inboxType = 'all'; state.inboxSel = null; state.focusKey = el.getAttribute('data-focus'); state.cross = null; state.view = 'inbox'; render(); break;
      case 'inbox-type': state.inboxType = id; state.inboxSel = null; state.focusKey = el.getAttribute('data-focus'); state.cross = null; state.view = 'inbox'; render(); break;
      case 'inbox-sel': state.inboxSel = id; state.focusKey = el.getAttribute('data-focus'); render(); break;
      case 'inbox-go': openInbox(id, null, el.closest('#stage') !== null); break;
      case 'board-proj': {
        if (id !== 'all' && !projectAccess(projById(id))) break;
        state.boardProj = id; if (id !== 'all') state.proj = id;
        state.taskSel = null; state.focusKey = el.getAttribute('data-focus');
        goView('board'); break;
      }
      case 'board-scope': state.boardScope = id; state.focusKey = el.getAttribute('data-focus'); render(); break;
      case 'board-view': state.boardView = id; state.focusKey = el.getAttribute('data-focus'); render(); break;
      case 'board-issues': state.boardOnlyIssues = !state.boardOnlyIssues; render(); break;
      case 'task-reassign': {
        var tr = taskById(id);
        if (!tr) break;
        var tp = projById(tr.proj);
        var candidates = (tp ? tp.members : []).filter(function (m) { return m !== tr.to && m !== ME; });
        if (!candidates.length) candidates = (tp ? tp.members : []).filter(function (m) { return m !== tr.to; });
        journeyDialog('改派任务', '<div class="c4-panel"><p class="meta">原指派人已拒绝：' + esc(tr.reason || '未填写理由') + '</p>' +
          '<div class="fld"><label for="reassignTo">改派给</label><select id="reassignTo">' + candidates.map(function (m) {
            return '<option value="' + m + '">' + esc(PEOPLE[m].name + ' · ' + PEOPLE[m].role) + '</option>';
          }).join('') + '</select></div></div>', journeyBtn('task-reassign-ok', '确认改派', tr.id, true), tr.title);
        break;
      }
      case 'task-reassign-ok': {
        var rt = taskById(id), rs = $('#reassignTo');
        if (!rt || !rs || !rs.value) break;
        rt.to = rs.value; rt.status = 'open'; rt.reason = ''; rt.time = '刚刚';
        closeDialog('dlgJourney'); render();
        toast('已改派给 ' + PEOPLE[rt.to].name + ' · 等待对方接受');
        break;
      }
      case 'task-close': closeTaskDrawer(); break;
      case 'task-new': openDispatchDialog(null, { type: 'board' }); break;
      case 'task-decline': {
        var td = taskById(id);
        if (!td || td.to !== ME || td.status !== 'open') break;
        journeyDialog('拒绝任务', '<div class="c4-panel"><p class="meta">拒绝后任务退回给 ' + esc(PEOPLE[td.from].name) + '，对方可以改派或关闭。</p>' +
          '<div class="fld"><label for="taskReason">拒绝理由</label><input id="taskReason" type="text" placeholder="例如：这块不在我负责的服务里，建议找王大林"></div></div>',
          journeyBtn('task-decline-ok', '确认拒绝', td.id, true), td.title);
        break;
      }
      case 'task-decline-ok': {
        var tx = taskById(id), rx = $('#taskReason');
        if (!tx || !rx) break;
        if (!rx.value.trim()) { showJourneyErr('请先填写拒绝理由，方便发布人改派或关闭。', rx); break; }
        tx.status = 'declined'; tx.reason = rx.value.trim();
        closeDialog('dlgJourney'); render();
        toast('已拒绝 · 任务退回给 ' + PEOPLE[tx.from].name);
        break;
      }
      case 'req-approve': {
        var rq = state.requests.filter(function (r) { return r.id === id; })[0];
        if (!rq || rq.status !== 'pending' || !isAdmin(rq.ws)) break;
        var rws = wsById(rq.ws);
        if (rq.kind === 'join') { if (rws.members.indexOf(rq.from) < 0) rws.members.push(rq.from); rws.roles[rq.from] = '开发者'; }
        else rws.roles[rq.from] = rq.role;
        rq.status = 'approved'; render();
        toast(rq.kind === 'join' ? PEOPLE[rq.from].name + ' 已加入 ' + rws.name : PEOPLE[rq.from].name + ' 已设为' + rq.role);
        break;
      }
      case 'req-reject': {
        var rj = state.requests.filter(function (r) { return r.id === id; })[0];
        if (!rj) break;
        journeyDialog('拒绝申请', '<div class="c4-panel"><div class="fld"><label for="reqReason">拒绝理由</label><input id="reqReason" type="text" placeholder="会展示给申请人"></div></div>',
          journeyBtn('req-reject-ok', '确认拒绝', rj.id, true), PEOPLE[rj.from].name + ' ' + reqTitle(rj));
        break;
      }
      case 'req-reject-ok': {
        var rk = state.requests.filter(function (r) { return r.id === id; })[0], rr = $('#reqReason');
        if (!rk || !rr) break;
        if (!rr.value.trim()) { toast('请先填拒绝理由'); rr.focus(); break; }
        rk.status = 'rejected'; rk.reason = rr.value.trim();
        closeDialog('dlgJourney'); render(); toast('已拒绝申请');
        break;
      }
      case 'at-person': {
        var cs2 = curSession();
        state.atq = null;
        if (!cs2 || !cs2.shareProject) { toast('先把会话发布到 Project，才能 @ 成员派任务'); render(); break; }
        openDispatchDialog(id, { type: 'session', title: cs2.title, proj: cs2.shareProject });
        break;
      }
      case 'sess-menu':
        if (!$('#menu').hidden && $('#menu').dataset.kind === 'sess') { closeMenu(true); break; }
        closeMenu(); openMenu('sess', el); break;
      case 'team-menu':
        if (!$('#menu').hidden && $('#menu').dataset.kind === 'team') { closeMenu(true); break; }
        closeMenu(); openMenu('team', el); break;
      case 'sess-filter': state.sessFilter = id || 'all'; closeMenu(); render(); break;
      case 'team-pick': {
        var ts = curSession();
        var locked = ts && (ts.msgs || []).some(function (m) { return m.w === ts.owner; });
        if (!ts || locked) break;
        var tid = id === 'none' ? null : id;
        if (tid && !teamRole(tid, ME)) break;
        ts.team = tid;
        closeMenu(); render();
        toast('团队上下文已改为 ' + wsById(tid).name);
        break;
      }
      case 'sess-dir': {
        var dp = el.getAttribute('data-dir');
        var nextOpen = state.dirOpen[dp] === false;
        state.dirOpen[dp] = nextOpen;
        el.classList.toggle('is-closed', !nextOpen);
        el.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        var grpWrap = el.parentElement && el.parentElement.querySelector('.grp-collapse');
        if (grpWrap) { grpWrap.setAttribute('data-open', nextOpen ? '1' : '0'); grpWrap.setAttribute('aria-hidden', nextOpen ? 'false' : 'true'); }
        break;
      }
      case 'collab-proj': {
        var cpj = el.getAttribute('data-id');
        var cpo = (cpj in state.collabOpen) ? state.collabOpen[cpj] : cpj === state.proj;
        var nextCp = !cpo;
        state.collabOpen[cpj] = nextCp;
        el.classList.toggle('is-closed', !nextCp);
        el.setAttribute('aria-expanded', nextCp ? 'true' : 'false');
        var cpWrap = el.closest('.cp-proj') && el.closest('.cp-proj').querySelector('.grp-collapse');
        if (cpWrap) { cpWrap.setAttribute('data-open', nextCp ? '1' : '0'); cpWrap.setAttribute('aria-hidden', nextCp ? 'false' : 'true'); }
        break;
      }
      case 'collab-member': {
        var cmk = el.getAttribute('data-proj') + ':' + el.getAttribute('data-owner');
        var cmdef = el.getAttribute('data-owner') === 'me';
        var cmo = (cmk in state.memberOpen) ? state.memberOpen[cmk] : cmdef;
        state.memberOpen[cmk] = !cmo;
        state.focusKey = el.getAttribute('data-focus');
        render(); break;
      }
      case 'collab-nav': {
        var tpj = projById(el.getAttribute('data-proj'));
        if (!projectAccess(tpj)) break;
        state.proj = tpj.id; state.ws = tpj.ws;
        goView(el.getAttribute('data-view'));
        break;
      }
      case 'know-scope': state.kscope = el.getAttribute('data-scope'); goView('knowledge'); break;
      case 'ws-menu':
        if (!$('#menu').hidden && $('#menu').dataset.kind === 'ws') { closeMenu(true); break; }
        closeMenu(); openMenu('ws', el); break;
      case 'proj-menu':
        if (!$('#menu').hidden && $('#menu').dataset.kind === 'proj') { closeMenu(true); break; }
        closeMenu(); openMenu('proj', el); break;
      case 'dir-menu':
        closeMenu(); openDirs(); break;
      case 'pick-ws':
        if (!teamRole(id, ME)) break;
        state.ws = id;
        var ps = wsProjects();
        state.proj = ps.length ? ps[0].id : null;
        state.cross = null;
        state.projEdit = false;
        state.boardProj = 'all'; state.taskSel = null;
        if (state.view !== 'inbox') {
          if (state.space === 'team') state.view = (state.view === 'knowledge' || state.sidePane === 'knowledge') ? 'knowledge' : 'board';
          else { state.view = 'chat'; state.shouldScrollEnd = true; }
        }
        closeMenu(); render(); toast('已切换到 ' + curWs().name); break;
      case 'pick-proj': switchProject(id); break;
      case 'new-project': closeMenu(); openProjectDialog(); break;
      case 'new-session': openSessionDialog(); break;
      case 'new-project-session': openSessionDialog(true); break;
      case 'session-create': createFromForm(); break;
      case 'nav':
        if (el.getAttribute('data-view') === 'settings') { openSettings(); break; }
        goView(el.getAttribute('data-view')); break;
      case 'session': openSession(id); break;
      case 'member-peek': {
        var wantOwner = el.getAttribute('data-owner');
        if (!$('#popover').hidden && state.pop.owner === wantOwner) { closePopover(true); break; }
        openPopover(wantOwner);
        break;
      }
      case 'pop-close': closePopover(true); break;
      case 'pop-member':
        state.pop.owner = el.getAttribute('data-owner');
        state.focusKey = el.getAttribute('data-focus') || ('pop-m-' + state.pop.owner);
        renderPopover();
        break;
      case 'side-toggle':
        state.side = !state.side;
        state.sideFloat = false;
        state.drawer = false;
        $('#sidebar').classList.remove('is-open');
        $('#scrim').hidden = true;
        render(); break;
      case 'open-settings': openSettings(); break;
      case 'toggle-tool': {
        var tid = el.getAttribute('data-tid');
        if (tid) {
          var cur = (tid in state.openTools) ? !!state.openTools[tid] : (el.getAttribute('data-def-open') === '1');
          var nextT = !cur;
          state.openTools[tid] = nextT;
          el.setAttribute('aria-expanded', nextT ? 'true' : 'false');
          var scope = el.closest('.tl-wc, .tl-sub, .tl-body') || $('#stage');
          var bodyCol = scope && scope.querySelector('[data-tid-body="' + tid + '"]');
          var sumCol = scope && scope.querySelector('[data-tid-sum="' + tid + '"]');
          if (bodyCol) { bodyCol.setAttribute('data-open', nextT ? '1' : '0'); bodyCol.setAttribute('aria-hidden', nextT ? 'false' : 'true'); }
          if (sumCol) { sumCol.setAttribute('data-open', nextT ? '0' : '1'); sumCol.setAttribute('aria-hidden', nextT ? 'true' : 'false'); }
        }
        break;
      }
      case 'approve': {
        var aid = el.getAttribute('data-id');
        var dec = el.getAttribute('data-dec');
        if (aid && dec) {
          state.approvalTimers = state.approvalTimers || {};
          if (state.approvalTimers[aid]) clearTimeout(state.approvalTimers[aid]);
          state.approvalDecisions[aid] = dec;
          if (dec !== 'denied') {
            state.approvalBusy[aid] = true;
            renderSidebar(); renderStage();
            state.approvalTimers[aid] = setTimeout(function () {
              delete state.approvalBusy[aid];
              if (state.approvalDecisions[aid] !== dec) return;
              renderSidebar();
              if (state.view === 'chat' && !state.cross && document.querySelector('.tl-appr [data-id="' + aid + '"]')) renderStage();
              toast(dec === 'always' ? '本会话已放行该操作，本机继续执行' : '已允许本次执行，已继续');
            }, 340);
          } else {
            renderSidebar(); renderStage();
            toast('已拒绝，本次执行已中止');
          }
        }
        break;
      }
      case 'approve-reset': {
        var rid = el.getAttribute('data-id');
        if (rid) {
          if (state.approvalTimers && state.approvalTimers[rid]) { clearTimeout(state.approvalTimers[rid]); delete state.approvalTimers[rid]; }
          delete state.approvalDecisions[rid]; delete state.approvalBusy[rid]; renderSidebar(); renderStage(); toast('已撤销，重新等待审批');
        }
        break;
      }
      case 'copy-code': {
        var cid = el.getAttribute('data-cid');
        copyText(CODE_MAP[cid] || '', '代码已复制');
        state.copiedKey = cid;
        put(el, icon('check', 11) + '已复制'); el.classList.add('is-copied');
        setTimeout(function () {
          if (state.copiedKey === cid) state.copiedKey = null;
          if (el.isConnected) { put(el, icon('copy', 11) + '复制'); el.classList.remove('is-copied'); }
        }, 1800);
        break;
      }
      case 'copy-msg': {
        var mk = el.getAttribute('data-mid');
        copyText(MSG_TEXT_MAP[mk] || '', '回复内容已复制');
        state.copiedKey = 'msg:' + mk;
        put(el, icon('check', 14)); el.classList.add('is-copied'); el.setAttribute('aria-label', '已复制回复');
        setTimeout(function () {
          if (state.copiedKey === 'msg:' + mk) state.copiedKey = null;
          if (el.isConnected) { put(el, icon('copy', 14)); el.classList.remove('is-copied'); el.setAttribute('aria-label', '复制回复'); }
        }, 1800);
        break;
      }
      case 'quote-msg': {
        var qk = el.getAttribute('data-mid');
        var raw = (MSG_TEXT_MAP[qk] || '').split('\n')[0].trim();
        var ta = $('#composer');
        var cs = curSession();
        if (ta && cs) {
          var snip = raw.length > 48 ? raw.slice(0, 48) + '…' : raw;
          ta.value = '> ' + snip + '\n\n' + ta.value;
          state.drafts[cs.id] = ta.value;
          focusComposerEnd();
        } else {
          toast('仅本机会话支持引用追问');
        }
        break;
      }
      case 'prompt-jump': {
        var pIdx = parseInt(el.getAttribute('data-pidx'), 10);
        if (!isNaN(pIdx)) jumpToPrompt(pIdx);
        break;
      }
      case 'prompt-prev': {
        var curPrev = state.activePromptIdx || 0;
        if (curPrev > 0) jumpToPrompt(curPrev - 1);
        break;
      }
      case 'prompt-next': {
        var curNext = state.activePromptIdx || 0;
        jumpToPrompt(curNext + 1);
        break;
      }
      case 'copy-md': {
        var mid = el.getAttribute('data-id');
        var pm = findPlan(mid);
        copyText(pm ? planMarkdown(pm) : '', '计划已复制为 Markdown');
        state.copiedKey = 'md:' + mid;
        put(el, icon('check', 13) + '已复制 Markdown'); el.classList.add('is-copied');
        setTimeout(function () {
          if (state.copiedKey === 'md:' + mid) state.copiedKey = null;
          if (el.isConnected) { put(el, icon('copy', 13) + '复制 Markdown'); el.classList.remove('is-copied'); }
        }, 1800);
        break;
      }
      case 'plan-confirm': {
        var pid = el.getAttribute('data-id');
        if (pid) { state.plansConfirmed[pid] = true; renderStage(); toast('已确认，按计划开始执行'); }
        break;
      }
      case 'know-chip': {
        var kt = el.getAttribute('data-title') || '';
        var hit = state.knowledge.filter(function (k) { return k.title === kt; })[0];
        if (hit) { state.kSel = hit.id; state.kscope = 'all'; goView('knowledge'); toast('已打开《' + hit.title + '》'); }
        else toast('这条知识还没沉淀到知识库');
        break;
      }
      case 'file-open':
        openFile(el.getAttribute('data-file'), el.getAttribute('data-diff') === '1');
        break;
      case 'tab-file':
        if (state.preview) { state.preview.active = el.getAttribute('data-file'); render(); }
        break;
      case 'tab-close':
        closeFile(el.getAttribute('data-file'));
        break;
      case 'tab-chat':
        state.preview = null; state.pvMax = false; render(); break;
      case 'pv-max':
        state.pvMax = !state.pvMax; render(); break;
      case 'ptab':
        state.ptab = el.getAttribute('data-tab');
        state.focusKey = el.getAttribute('data-focus') || ('ptab-' + state.ptab);
        render(); break;
      case 'dock-tab':
        state.dockTab = el.getAttribute('data-tab');
        state.focusKey = el.getAttribute('data-focus') || ('dock-' + state.dockTab);
        renderRail(); break;
      case 'dock-refresh':
        toast(state.dockTab === 'changes' ? '已刷新工作区变更' : '已刷新文件状态');
        break;
      case 'tree-toggle': {
        var tdir = el.getAttribute('data-dir');
        state.treeOpen[tdir] = state.treeOpen[tdir] === false ? true : false;
        renderRail();
        var again = document.querySelector('[data-act="tree-toggle"][data-dir="' + tdir + '"]');
        if (again) { again.tabIndex = 0; again.focus(); }
        break;
      }
      case 'git-all': {
        var list = gitFilteredChanges(changesOf(curSession()));
        var every = list.length > 0 && list.every(function (f) { return state.gitSel[f.n]; });
        list.forEach(function (f) { state.gitSel[f.n] = !every; });
        refreshGitList(); break;
      }
      case 'git-sel-clear':
        state.gitSel = {};
        refreshGitList(); break;
      case 'git-toggle': {
        var gf = el.getAttribute('data-file');
        state.gitSel[gf] = !state.gitSel[gf];
        refreshGitList(); break;
      }
      case 'git-dir-toggle': {
        var gdir = el.getAttribute('data-dir');
        state.gitDirOpen[gdir] = state.gitDirOpen[gdir] === false ? true : false;
        refreshGitList(); break;
      }
      case 'git-dir-sel': {
        var rawPaths = el.getAttribute('data-paths') || '';
        var dirPaths = rawPaths ? rawPaths.split('\n') : [];
        var allOn = dirPaths.length > 0 && dirPaths.every(function (p) { return !!state.gitSel[p]; });
        dirPaths.forEach(function (p) { state.gitSel[p] = !allOn; });
        refreshGitList(); break;
      }
      case 'git-sub':
        state.gitSub = el.getAttribute('data-sub') || 'changes';
        state.focusKey = el.getAttribute('data-focus') || ('git-sub-' + state.gitSub);
        renderRail(); break;
      case 'git-view':
        state.gitView = el.getAttribute('data-view') || 'auto';
        renderRail(); break;
      case 'git-st':
        state.gitFilterSt = el.getAttribute('data-st') || 'all';
        renderRail(); break;
      case 'git-stress':
        state.gitStress = !state.gitStress;
        state.gitLogLimit = 8;
        state.openCommitAll = {};
        state.openCommit = state.gitStress ? 'a83f2c1' : null;
        render();
        toast(state.gitStress ? '已切换至 22 文件 / 16 提交压测示例' : '已恢复常规工作区示例');
        break;
      case 'git-q-clear':
        state.gitQ = '';
        renderRail();
        var gqi = $('#gitQInput'); if (gqi) gqi.focus();
        break;
      case 'git-log-scope':
        state.gitLogScope = el.getAttribute('data-scope') || 'all';
        renderRail(); break;
      case 'git-log-q-clear':
        state.gitLogQ = '';
        renderRail();
        var glqi = $('#gitLogQInput'); if (glqi) glqi.focus();
        break;
      case 'git-commit-toggle': {
        var sha = el.getAttribute('data-sha');
        state.openCommit = state.openCommit === sha ? null : sha;
        refreshGitLog(); break;
      }
      case 'git-commit-all': {
        var csha = el.getAttribute('data-sha');
        state.openCommitAll[csha] = true;
        refreshGitLog(); break;
      }
      case 'git-log-more':
        state.gitLogLimit = (state.gitLogLimit || 8) + 8;
        refreshGitLog(); break;
      case 'diff-step': {
        var stepList = changesOf(curSession());
        if (!stepList.length) break;
        var curP = state.preview ? state.preview.active : '';
        var idx = -1;
        for (var si = 0; si < stepList.length; si++) { if (stepList[si].n === curP) { idx = si; break; } }
        var dir = parseInt(el.getAttribute('data-dir'), 10) || 1;
        var nextIdx = idx < 0 ? 0 : (idx + dir + stepList.length) % stepList.length;
        state.focusKey = el.getAttribute('data-focus') || (dir < 0 ? 'diff-step-prev' : 'diff-step-next');
        openFile(stepList[nextIdx].n, true, true);
        break;
      }
      case 'k-select':
        state.kSel = id;
        state.kEdit = false;
        render(); break;
      case 'k-edit':
        state.kEdit = true;
        render();
        var ke = $('#kEditArea'); if (ke) { ke.focus(); ke.setSelectionRange(ke.value.length, ke.value.length); }
        break;
      case 'k-cancel':
        state.kEdit = false;
        render(); break;
      case 'k-save': {
        var kb = state.knowledge.filter(function (k) { return k.id === id; })[0];
        var ta = $('#kEditArea');
        var sumEl = $('#kSumEdit');
        if (kb && ta) {
          if (sumEl && sumEl.value.trim()) kb.sum = sumEl.value.trim();
          kb.body = ta.value.trim() || kb.body || kb.sum;
          kb.version = bumpVersion(kb.version);
          kb.updated = '刚刚';
          kb.hist = kb.hist || [];
          kb.hist.push({ who: ME, act: '直接编辑', ver: kb.version, date: '刚刚' });
          state.kEdit = false;
          render();
          toast('已保存为新版本 ' + kb.version);
        }
        break;
      }
      case 'cite-knowledge': {
        var ckb = state.knowledge.filter(function (k) { return k.id === id; })[0];
        if (!ckb || !teamRole(ckb.ws, ME)) break;
        var locals = localSessions();
        var targetSess = locals.filter(function (s) { return s.id === state.session; })[0] || locals[0];
        if (!targetSess) {
          var pObj = curProj();
          targetSess = addSession('引用《' + ckb.title + '》', ckb.ws, '~/work/harness/' + (pObj.repo ? baseName(pObj.repo) : 'workspace'), null);
        }
        var curDraft = state.drafts[targetSess.id] || '';
        var token = '@《' + ckb.title + '》' + ckb.version + ' ';
        state.drafts[targetSess.id] = curDraft ? (curDraft.replace(/\s*$/, ' ') + token) : token;
        state.session = targetSess.id;
        state.cross = null;
        state.returnTo = null;
        state.view = 'chat';
        state.preview = null;
        syncSpaceFor(targetSess);
        render();
        focusComposerEnd();
        toast('已在「' + (targetSess.shareProject ? '团队协作' : '个人') + '」会话插入《' + ckb.title + '》');
        break;
      }
      case 'proj-edit':
        if (curProj().lead !== ME) break;
        state.projEdit = true;
        render();
        var pe = $('#peName'); if (pe) pe.focus();
        break;
      case 'proj-cancel':
        state.projEdit = false;
        render(); break;
      case 'proj-save': {
        var pr = curProj();
        if (pr.lead !== ME) break;
        var peEl = $('#peName'), peErr = $('#peNameErr');
        var nm = peEl ? peEl.value.trim() : '';
        if (!nm) {
          if (peErr) { peErr.textContent = '请填写项目名称。'; peErr.hidden = false; }
          if (peEl) peEl.focus();
          break;
        }
        if (peErr) peErr.hidden = true;
        pr.name = nm;
        if ($('#peDesc')) pr.desc = $('#peDesc').value.trim();
        pr.repo = $('#peRepo') ? $('#peRepo').value.trim() : pr.repo;
        var picked = [ME].concat($$('input[name="peMember"]:checked').map(function (i) { return i.value; }))
          .filter(function (v, i, a) { return a.indexOf(v) === i; });
        if (picked.length) pr.members = picked;
        state.projEdit = false;
        render();
        toast('已更新 Project 资料与成员');
        break;
      }
      case 'pop-filter':
        state.pop.filter = el.getAttribute('data-filter');
        state.focusKey = el.getAttribute('data-focus') || ('pop-f-' + state.pop.filter);
        renderPopover();
        break;
      case 'pop-open': openPeer(el.getAttribute('data-owner'), id); break;
      case 'peer-sync': {
        var p = curPeer();
        if (!p || p.archived) break;
        state.synced[snapshotKey(p)] = JSON.parse(JSON.stringify(Object.assign({}, p, { reader: ME })));
        state.shouldScrollEnd = true;
        render(); toast('已同步为只读快照'); break;
      }
      case 'peer-cite': {
        var cp = curPeer();
        if (cp && peerIsSynced(cp)) citePeer(peerIsSynced(cp));
        break;
      }
      case 'peer-dispatch': openDispatchDialog(); break;
      case 'back-home': {
        var ret = state.returnTo;
        state.cross = null;
        state.returnTo = null;
        if (ret) {
          state.space = ret.space || 'team';
          state.view = ret.view || 'board';
          if (ret.boardScope) state.boardScope = ret.boardScope;
          if (ret.boardView) state.boardView = ret.boardView;
          if (ret.boardProj) state.boardProj = ret.boardProj;
          if (ret.proj) state.proj = ret.proj;
          if (ret.session) state.session = ret.session;
          if (ret.kscope) state.kscope = ret.kscope;
          render();
        } else {
          state.view = 'chat'; state.shouldScrollEnd = true; render();
        }
        break;
      }
      case 'task-open': {
        var t = taskById(id);
        if (!t || !projectAccess(projById(t.proj))) break;
        state.cross = null;
        state.taskSel = id;
        state.view = 'board';
        state.focusKey = 'task-' + id;
        render();
        break;
      }
      case 'task-jump': {
        var tj = taskById(id);
        if (!tj || !projectAccess(projById(tj.proj))) break;
        closePalette();
        if ($('#dlgJourney').open) closeDialog('dlgJourney');
        switchProject(tj.proj);
        state.boardScope = 'all';
        state.taskSel = id;
        render();
        break;
      }
      case 'know-jump': {
        var kws = el.getAttribute('data-ws');
        var kproj = el.getAttribute('data-proj');
        closePalette();
        if (kproj) {
          switchProject(kproj);
        } else if (kws && kws !== state.ws) {
          var firstP = state.projects.filter(function (p) { return p.ws === kws; })[0];
          if (firstP) switchProject(firstP.id);
        }
        state.cross = null;
        state.view = 'knowledge';
        state.kscope = 'all';
        state.kSel = id;
        state.kEdit = false;
        render();
        break;
      }
      case 'claim': resolveInboxRowThen(function () { claimTask(id); }); break;
      case 'start': openStartDialog(id); break;
      case 'finish': finishTask(id); break;
      case 'goto-session': openSession(id); break;
      case 'kscope':
        state.kscope = el.getAttribute('data-scope');
        state.focusKey = el.getAttribute('data-focus') || ('kscope-' + state.kscope);
        render();
        break;
      case 'new-knowledge': openDraft('supplement', 'k2'); break;
      case 'accent': {
        state.accent = el.getAttribute('data-accent-id');
        state.focusKey = el.getAttribute('data-focus') || ('set-accent-' + state.accent);
        render();
        break;
      }
      case 'theme':
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        render(); break;
      case 'theme-set':
        state.theme = el.getAttribute('data-theme-id');
        state.focusKey = el.getAttribute('data-focus') || ('set-theme-' + state.theme);
        render(); break;
      case 'density':
        state.density = el.getAttribute('data-density-id');
        state.focusKey = el.getAttribute('data-focus') || ('set-density-' + state.density);
        render(); break;
      case 'zoom':
        state.zoom = parseFloat(el.getAttribute('data-zoom')) || 1;
        state.focusKey = el.getAttribute('data-focus') || ('set-zoom-' + state.zoom);
        render(); break;
      case 'rail':
        state.rail = !state.rail;
        if (window.innerWidth <= 1040) {
          if (state.rail) { closeMobileDrawer(); $('#scrim').hidden = false; }
          else if (!state.drawer) { $('#scrim').hidden = true; }
        }
        render(); break;
      case 'drawer':
        state.drawer = true;
        $('#sidebar').classList.add('is-open');
        $('#scrim').hidden = false;
        renderSidebar();
        var firstRail = $('#sidebar button');
        if (firstRail) firstRail.focus();
        break;
      case 'drawer-close':
        state.drawer = false;
        $('#sidebar').classList.remove('is-open');
        if (window.innerWidth <= 1040 && state.rail) state.rail = false;
        $('#scrim').hidden = true;
        renderRail();
        var db = $('#drawerBtn');
        if (db && window.innerWidth <= 760) db.focus();
        break;
      case 'palette': openPalette(); break;
      case 'send': sendMessage(); break;
      case 'at-open': {
        var ta = $('#composer');
        var cs = curSession();
        if (ta && cs) {
          ta.value = ta.value.replace(/\s*$/, ta.value.trim() ? ' ' : '') + '@';
          state.drafts[cs.id] = ta.value;
          state.atq = '';
          state.atIdx = 0;
          updateAtMount();
          focusComposerEnd();
        }
        break;
      }
      case 'at-pick': pickKnowledge(id); break;
      case 'dlg-close': closeDialog(el.getAttribute('data-dlg')); break;
    }
  }

  function focusComposerEnd() {
    var ta = $('#composer');
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function pickKnowledge(kid) {
    var kb = state.knowledge.filter(function (k) { return k.id === kid; })[0];
    if (!kb) return;
    var ta = $('#composer');
    var s = curSession();
    if (!ta || !s) return;
    ta.value = ta.value.replace(/(^|\s)@([^\s@]*)$/, function (m, pre) { return pre + '@《' + kb.title + '》' + kb.version + ' '; });
    state.drafts[s.id] = ta.value;
    state.atq = null;
    state.atIdx = 0;
    updateAtMount();
    focusComposerEnd();
  }

  function sendMessage() {
    var ta = $('#composer');
    if (!ta) return;
    var v = ta.value;
    if (!v.trim()) { ta.focus(); return; }
    var s = curSession();
    if (!s || state.cross) return;
    s.msgs = s.msgs || [];
    s.msgs.push({ w: ME, time: '刚刚', text: v });
    var thItem = {
      w: 'thinking', label: '思考过程', dur: '进行中…',
      body: ['正在定位当前工作区受影响的模块与测试边界，确认改动前提…']
    };
    var wgItem = {
      w: 'workgroup', title: '正在检查工作区上下文…', dur: '进行中…',
      summary: '读取相关源码并检索调用引用',
      rows: [
        { ic: 'eye', verb: 'read_file', target: 'src/payment/state-machine.ts', badge: '读取中…' },
        { ic: 'search', verb: 'grep', target: 'refundGateway', badge: '检索中…' }
      ]
    };
    var thIdx = s.msgs.length;
    s.msgs.push(thItem);
    var wgIdx = s.msgs.length;
    s.msgs.push(wgItem);
    s.time = '刚刚';
    s.unread = false;
    s.running = true;
    state.drafts[s.id] = '';
    state.atq = null;
    state.shouldScrollEnd = true;
    render();
    toast('已发送到本机会话');
    setTimeout(function () {
      thItem.dur = '1.1s';
      wgItem.title = '已完成 2 步检查';
      wgItem.dur = '0.9s';
      wgItem.rows = [
        { ic: 'eye', verb: 'read_file', target: 'src/payment/state-machine.ts', badge: '42 行', tone: 'ok', file: 'src/payment/state-machine.ts',
          out: 'PAID -> [REFUNDING, PARTIAL_REFUNDED]' },
        { ic: 'search', verb: 'grep', target: 'refundGateway', badge: '命中 2 处', tone: 'ok', file: 'src/payment/callback/refund.ts',
          out: 'callback/refund.ts:44  refundGateway.confirm(payload)' }
      ];
      s.msgs.push({
        w: 'agent', model: 'claude-sonnet-4', time: '刚刚',
        blocks: [
          { t: 'p', text: '已结合本机工作目录上下文核对完成：针对「' + (v.length > 26 ? v.slice(0, 26) + '…' : v) + '」，建议先校验幂等键拦截后再推进状态流转。' }
        ]
      });
      delete state.openTools['th:' + s.id + ':' + thIdx];
      delete state.openTools['wg:' + s.id + ':' + wgIdx];
      s.running = false;
      if (state.session === s.id && state.view === 'chat' && !state.cross) {
        state.shouldScrollEnd = true;
        render();
      }
    }, 950);
  }

  /* ═══════════ 事件绑定 ═══════════ */
  document.addEventListener('click', function (e) {
    var actEl = e.target.closest('[data-act]');

    if (!e.target.closest('#menu') && !e.target.closest('[data-act="ws-menu"]') && !e.target.closest('[data-act="proj-menu"]') && !e.target.closest('[data-act="dir-menu"]') && !e.target.closest('[data-act="sess-menu"]') && !e.target.closest('[data-act="team-menu"]')) closeMenu();
    if (!e.target.closest('#popover') && !e.target.closest('[data-act="member-peek"]')) closePopover();
    if (actEl) {
      var closeFloat = state.sideFloat && !actEl.closest('#sidebar') && !actEl.closest('#menu') && !actEl.closest('#popover');
      handle(actEl);
      if (closeFloat) { state.sideFloat = false; renderSidebar(); }
      return;
    }
    if (state.sideFloat && !e.target.closest('#sidebar') && !e.target.closest('#menu') && !e.target.closest('#popover') && !e.target.closest('#palette') && !e.target.closest('dialog')) { state.sideFloat = false; render(); }
    if (e.target.id === 'palette') closePalette();
  });

  document.addEventListener('input', function (e) {
    var role = e.target.getAttribute && e.target.getAttribute('data-role');
    if (role === 'pop-q') { state.pop.q = e.target.value; refreshPopList(); }
    else if (role === 'git-q') { state.gitQ = e.target.value; refreshGitList(); }
    else if (role === 'git-log-q') { state.gitLogQ = e.target.value; refreshGitLog(); }
    else if (role === 'palette-q') {
      state.palQ = e.target.value;
      state.palIdx = 0;
      var pl = $('#palList'); if (pl) put(pl, paletteListHtml());
    }
    else if (role === 'composer') {
      var s = curSession();
      if (s) state.drafts[s.id] = e.target.value;
      var m = e.target.value.match(/(^|\s)@([^\s@]*)$/);
      var next = m && s && teamRole(s.team, ME) ? m[2] : null;
      if (next !== state.atq) {
        state.atq = next;
        state.atIdx = 0;
        updateAtMount();
      } else if (next !== null) {
        state.atIdx = 0;
        updateAtMount();
      }
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-role') === 'board-proj-sel') {
      state.boardProj = e.target.value; if (state.boardProj !== 'all') state.proj = state.boardProj;
      state.taskSel = null; render(); return;
    }
    if (e.target.id === 'sessTeamSel') { syncSessPublishRow(); return; }
    if (e.target.id === 'sessDir' || e.target.id === 'sessPublish') { renderNewDirs(); return; }
    if (e.target.name === 'sessExtra') {
      state.newDirs = e.target.checked ? Array.from(new Set(state.newDirs.concat(e.target.value))) : state.newDirs.filter(function (path) { return path !== e.target.value; });
      return;
    }
    if (e.target.name === 'c4Agent') {
      var session = curSession();
      if (session && !state.cross && ['multi', 'single'].includes(e.target.value)) changeAgent(session, e.target.value);
      return;
    }
    if (knowledgeChange(e.target)) return;
    if (e.target.id === 'startPick') { syncStartMode('existing'); return; }
    var modeWrap = e.target.closest('[data-start-mode]');
    if (modeWrap && e.target.name === 'startMode') { syncStartMode(e.target.value); return; }
  });

  document.addEventListener('keydown', function (e) {
    if (e.target.id === 'sessTitle' && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); createFromForm(); return; }
    if (e.target.id === 'sessDir' && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); renderNewDirs(); return; }
    if (e.target.id === 'journeyPath' && e.key === 'Enter' && !e.isComposing) {
      var commit = $('#dlgJourney [data-enter]');
      if (commit) { e.preventDefault(); handle(commit); return; }
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if ($('#palette').hidden) openPalette(); else closePalette(true);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault();
      handle({ getAttribute: function (k) { return k === 'data-act' ? 'side-toggle' : null; } });
      return;
    }
    if (!$('#palette').hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
      var pItems = $$('#palList .p-item');
      if (pItems.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          state.palIdx = (state.palIdx + (e.key === 'ArrowDown' ? 1 : pItems.length - 1)) % pItems.length;
          pItems.forEach(function (b, idx) { b.classList.toggle('is-hl', idx === state.palIdx); });
          pItems[state.palIdx].scrollIntoView({ block: 'nearest' });
          return;
        }
        if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'palQ') {
          e.preventDefault();
          pItems[state.palIdx].click();
          return;
        }
      }
    }
    if (!$('#menu').hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      var mItems = $$('#menu .menu-item');
      if (mItems.length) {
        e.preventDefault();
        var curM = mItems.indexOf(document.activeElement);
        var nextM = curM < 0 ? 0 : (curM + (e.key === 'ArrowDown' ? 1 : mItems.length - 1)) % mItems.length;
        mItems[nextM].focus();
        return;
      }
    }
    if (state.atq !== null && document.activeElement && document.activeElement.id === 'composer') {
      var aItems = $$('#atMenuMount .at-item');
      if (aItems.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing))) {
        e.preventDefault();
        if (e.key === 'Enter') { aItems[state.atIdx] && aItems[state.atIdx].click(); return; }
        state.atIdx = (state.atIdx + (e.key === 'ArrowDown' ? 1 : aItems.length - 1)) % aItems.length;
        aItems.forEach(function (b, idx) {
          b.classList.toggle('is-hl', idx === state.atIdx);
          b.setAttribute('aria-selected', idx === state.atIdx ? 'true' : 'false');
        });
        aItems[state.atIdx].scrollIntoView({ block: 'nearest' });
        return;
      }
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement) {
      var grp = document.activeElement.closest('[role="tablist"], [role="radiogroup"]');
      if (grp && !grp.classList.contains('choice-list')) {
        var btns = $$('button[role="tab"], button[role="radio"]', grp);
        var bi = btns.indexOf(document.activeElement);
        if (bi >= 0 && btns.length > 1) {
          e.preventDefault();
          var nb = btns[(bi + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
          nb.focus(); nb.click();
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && document.activeElement && document.activeElement.id === 'composer') {
      e.preventDefault(); sendMessage(); return;
    }
    if (e.key === 'Escape') {
      if (!$('#palette').hidden) { closePalette(true); return; }
      if (!$('#popover').hidden) { closePopover(true); return; }
      if (!$('#menu').hidden) { closeMenu(true); return; }
      if (state.atq !== null) { state.atq = null; updateAtMount(); var ta = $('#composer'); if (ta) ta.focus(); return; }
      if (state.pvMax) { state.pvMax = false; render(); return; }
      if (state.preview) { state.preview = null; state.pvMax = false; render(); return; }
      if (state.sideFloat) { state.sideFloat = false; render(); return; }
      if (state.view === 'board' && state.taskSel && !document.querySelector('dialog[open]')) { closeTaskDrawer(); return; }
      if (state.drawer) { handle({ getAttribute: function () { return 'drawer-close'; } }); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (document.activeElement && document.activeElement.id === 'composer') { e.preventDefault(); sendMessage(); }
    }
  });

  /* 表单 */
  $('#formProject').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('#projName').value.trim();
    var err = $('#projNameErr');
    if (!name) {
      err.textContent = '请填写项目名称，之后可以在项目资料里改。';
      err.hidden = false;
      $('#projName').focus();
      return;
    }
    err.hidden = true;
    var desc = $('#projDesc') ? $('#projDesc').value.trim() : '';
    var members = [ME].concat($$('#projMemberList input:checked').map(function (i) { return i.value; }))
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
    var repo = $('#projRepo').value.trim();
    var id = 'p-' + Date.now();
    state.projects.push({
      id: id, ws: state.ws, name: name, desc: desc, lead: ME,
      repo: repo, created: '刚刚', members: members
    });
    closeDialog('dlgProject');
    switchProject(id);
    toast('Project 已创建：' + name);
  });

  $('#projName').addEventListener('blur', function () {
    if (this.value.trim() !== '') return;
    var err = $('#projNameErr');
    err.textContent = '请填写项目名称。';
    err.hidden = false;
  });
  $('#projName').addEventListener('input', function () { $('#projNameErr').hidden = true; });

  function taskSessionOf(id) { return state.sessions.filter(function (x) { return x.id === id; })[0]; }
  function createFromForm() {
    var title = $('#sessTitle').value.trim();
    var err = $('#sessTitleErr');
    if (!title) { err.textContent = '请填写会话标题，用来在左侧列表里识别。'; err.hidden = false; $('#sessTitle').focus(); return; }
    err.hidden = true;
    var dir = localPath($('#sessDir').value);
    if (!dir) { toast('请选择以 ~/ 或 / 开头的本机目录'); $('#sessDir').focus(); return; }
    var selWs = $('#sessTeamSel') ? ($('#sessTeamSel').value === 'none' ? null : $('#sessTeamSel').value) : state.ws;
    var candProj = curProj();
    if (!candProj.id || candProj.ws !== selWs || !projectAccess(candProj)) candProj = state.projects.filter(function (p) { return p.ws === selWs && projectAccess(p); })[0] || null;
    var project = ($('#sessPublish').checked && projectAccess(candProj)) ? candProj : null;
    var session = addSession(title, selWs, dir, project && project.id, state.newDirs.filter(function (path) { return path !== dir; }));
    closeDialog('dlgSession');
    openSession(session.id);
    toast(project ? '会话已创建并发布到 ' + project.name : '个人会话已创建 · 仅本人');
  }
  $('#formSession').addEventListener('submit', function (e) { e.preventDefault(); createFromForm(); });

  $('#formStart').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = taskById(state.startTaskId);
    if (!t) { closeDialog('dlgStart'); return; }
    var mode = startMode();
    var dir = $('#startDir').value.trim() || '~/work/harness/workspace';
    var sid = null;
    if (mode === 'existing') {
      sid = $('#startPick').value;
      if (!sid) { toast('没有可用的本机会话，改成新建一个'); return; }
    } else {
      var title = $('#startNewTitle').value.trim();
      var err = $('#startNewErr');
      if (!title) { err.textContent = '给新会话起一个标题，方便之后回看。'; err.hidden = false; $('#startNewTitle').focus(); return; }
      err.hidden = true;
      sid = addSession(title, projById(t.proj).ws, dir, t.proj).id;
    }
    t.status = 'running';
    t.sessionId = sid;
    closeDialog('dlgStart');
    state.session = sid;
    state.cross = null;
    state.view = 'chat';
    state.taskSel = null;
    state.shouldScrollEnd = true;
    syncSpaceFor(taskSessionOf(sid));
    render();
    toast('任务已在本机开始');
  });

  $('#formDispatch').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = $('#disTitle').value.trim();
    var err = $('#disTitleErr');
    if (!title) { err.textContent = '请写清楚要对方做什么，一句话就行。'; err.hidden = false; $('#disTitle').focus(); return; }
    err.hidden = true;
    var src = state.dispatchSrc || { type: 'board', proj: state.proj };
    state.tasks.push({
      id: 't-' + Date.now(), proj: src.proj, title: title,
      from: ME, to: $('#disTo').value, status: 'open',
      prio: 'mid', time: '刚刚',
      desc: $('#disDesc').value.trim() || (src.type === 'board' ? '从看板派发。' : '从会话《' + src.title + '》派发，附带会话快照。'),
      sessionId: null, src: src.type === 'board' ? 'board' : 'session', srcTitle: src.title || ''
    });
    closeDialog('dlgDispatch');
    render();
    toast('任务已派发给 ' + PEOPLE[$('#disTo').value].name);
  });

  $('#disTitle').addEventListener('input', function () { $('#disTitleErr').hidden = true; });
  $('#sessTitle').addEventListener('input', function () { $('#sessTitleErr').hidden = true; });
  $('#startNewTitle').addEventListener('input', function () { $('#startNewErr').hidden = true; });

  /* ═══════════ 模块 A:多目录本机会话(HC-242) ═══════════ */
  function repoByName(name) {
    return SYS_MAP.repos.filter(function (r) { return r.name === name; })[0] || null;
  }
  function repoLocal(name) {
    var r = repoByName(name);
    return r && r.local ? r.local : '';
  }
  function repoPathToName(path) {
    var p = String(path || '').replace(/\/+$/, '');
    if (!p) return '';
    var hit = SYS_MAP.repos.filter(function (r) {
      return r.local && (r.local === p || p.indexOf('/' + r.name + '/') >= 0 || baseName(p) === r.name);
    })[0];
    return hit ? hit.name : baseName(p);
  }
  function repoNames(wsId) {
    return (WS_REPOS[wsId] || []).slice();
  }
  /* 主目录 + 附加目录 → s.repos;增删目录后必须重算,自动上下文条按它匹配规约 */
  function syncRepos(s) {
    if (!s) return [];
    s.extraDirs = (s.extraDirs || []).filter(Boolean);
    s.repos = [s.mainDir].concat(s.extraDirs).filter(Boolean).map(function (p) {
      var name = repoPathToName(p);
      return { name: name, path: p, main: p === s.mainDir, known: !!repoByName(name) };
    });
    return s.repos;
  }
  /* 智能附加目录建议:先读已发布系统地图,其次读本机 team.md 的关系 */
  function dirSuggestions(s) {
    var have = [s.mainDir].concat(s.extraDirs || []);
    var out = [];
    have.forEach(function (p) {
      var repo = repoByName(repoPathToName(p));
      if (!repo) return;
      repo.rel.forEach(function (rel) {
        if (out.some(function (x) { return x.name === rel.to; })) return;
        var local = repoLocal(rel.to);
        if (local && have.indexOf(local) >= 0) return;
        out.push({ name: rel.to, kind: rel.kind, ev: rel.ev, sure: rel.sure, local: local, from: repo.name });
      });
    });
    MEM.team.forEach(function (m) {
      var hit = m.key.indexOf(' → ') > 0 ? m.key.split(' → ')[1] : '';
      if (!hit || out.some(function (x) { return x.name === hit; })) return;
      var local = repoLocal(hit);
      if (local && have.indexOf(local) >= 0) return;
      var repo = repoByName(hit);
      if (!repo) return;
      out.push({ name: hit, kind: '本机记忆', ev: '', sure: false, local: local, from: 'team.md' });
    });
    return out;
  }
  function suggestSource() { return '已发布系统地图 ' + SYS_MAP.version + ' + 本机 team.md'; }

  function dirBody(s) {
    var mainRepo = repoByName(repoPathToName(s.mainDir));
    var extras = s.extraDirs || [];
    var sug = dirSuggestions(s);
    var cNow = ctxFor(s);
    return '<div class="c4-panel">' +
      '<div class="ib-banner" style="margin-bottom:2px"><span>当前目录组合已命中 <strong>' + cNow.rules.length + '</strong> 条规约直带 · 索引 ' + cNow.index.length + ' 条知识</span></div>' +
      '<p class="set-section-title" style="margin:0;padding:0">主目录</p>' +
      '<span class="c4-chip c4-path">' + esc(s.mainDir) + '</span>' +
      '<p class="meta">自动识别的团队仓库：' + esc(mainRepo ? mainRepo.name + ' · ' + mainRepo.duty : '未在系统地图登记，按普通目录处理') + '</p>' +
      '<p class="set-section-title">Agent 多目录能力</p>' +
      '<div class="choice-list" role="radiogroup" aria-label="Agent 多目录能力">' +
        [['multi', 'Harness Agent · 支持多目录', '主目录与附加目录都能在本机读写'], ['single', '单目录 Agent', '只能访问主目录，附加目录不会被读取']].map(function (opt) {
          var on = (s.agent || 'multi') === opt[0];
          return '<label class="choice ' + (on ? 'is-on' : '') + '"><input type="radio" name="c4Agent" value="' + opt[0] + '"' + (on ? ' checked' : '') + '>' +
            '<span class="c-main"><span class="c-t">' + esc(opt[1]) + '</span><span class="c-d">' + esc(opt[2]) + '</span></span></label>';
        }).join('') +
      '</div>' +
      (s.agent === 'single'
        ? '<div class="k-warn"><span>当前 Agent 仅支持访问主目录，附加目录与其中的仓库不会被读取。</span><div class="c4-bar">' +
            journeyBtn('ctx-common-parent', '改选共同上级目录') + journeyBtn('ctx-use-multi', '换用支持的 Agent') +
            journeyBtn('ctx-newref', '在目标仓库新建会话并带上引用') + '</div></div>'
        : '') +
      '<p class="set-section-title">已添加的附加目录（' + extras.length + '）</p>' +
      (extras.length ? extras.map(function (p) {
        var repo = repoByName(repoPathToName(p));
        return '<div class="c4-row"><span class="od-fill od-stack"><span class="c4-path">' + esc(p) + '</span>' +
          '<span class="meta">' + esc(repo ? repo.name + ' · ' + repo.duty : '普通目录，未登记为团队仓库') + '</span></span>' +
          journeyBtn('dir-remove', '移除', p) + '</div>';
      }).join('') : '<p class="meta">还没有附加目录。可以从下面的建议里加，也可以手动输入路径。</p>') +
      '<div class="fld"><label for="dirNewInput">添加附加目录</label><input type="text" id="dirNewInput" placeholder="~/work/harness/common-proto">' +
        '<p class="help">只在本机读取；本机未克隆的仓库只提示，不会远程读文件。</p></div>' +
      '<div class="c4-bar">' + journeyBtn('dir-add', '加入附加目录', '', true) + '</div>' +
      '<p class="set-section-title">智能附加目录建议 · 来源：' + esc(suggestSource()) + '</p>' +
      (sug.length ? sug.map(function (x) {
        return '<div class="c4-row"><span class="od-fill od-stack"><span>' + esc(x.name) + ' ' +
          '<span class="kb ' + (x.local ? 'is-rule' : 'is-pending') + '">' + (x.local ? '本机已有副本' : '本机未克隆') + '</span></span>' +
          '<span class="meta">' + esc(x.kind + ' · 来自 ' + x.from) + (x.ev ? ' · 证据 ' + esc(x.ev) : ' · 关系为推测') + '</span>' +
          (x.local ? '<span class="c4-path">' + esc(x.local) + '</span>' : '<span class="meta">本机没有副本，只提示依赖关系，不远程读取。</span>') + '</span>' +
          (x.local ? journeyBtn('dir-suggest', '加入附加目录', x.local) : '') + '</div>';
      }).join('') : '<p class="meta">主目录没有登记到系统地图的依赖关系。</p>') +
    '</div>';
  }
  function openDirs() {
    var s = curSession();
    if (!s || state.cross) return;
    syncRepos(s);
    journeyDialog('本机会话目录与仓库', dirBody(s), '', s.title + ' · 只在本机执行');
  }
  function changeAgent(s, mode) {
    if (!s || ['multi', 'single'].indexOf(mode) < 0) return;
    s.agent = mode;
    render();
    if ($('#dlgJourney').open) openDirs();
    toast(mode === 'single' ? '已切换为单目录 Agent · 附加目录不再参与上下文' : '已切换为支持多目录的 Agent');
  }
  /* 新建会话弹窗里的附加目录建议 */
  function renderNewDirs() {
    var mount = $('#sessSuggestions');
    if (!mount) return;
    var dirEl = $('#sessDir');
    var dir = dirEl ? dirEl.value.trim() : '';
    var picked = state.newDirs || [];
    var sug = dir ? dirSuggestions({ mainDir: dir, extraDirs: picked }) : [];
    var html = '';
    if (picked.length) {
      html += '<div class="fld"><span style="font-size:var(--text-sm);font-weight:600">附加目录（' + picked.length + '）</span>' +
        picked.map(function (p) {
          return '<div class="c4-row"><span class="c4-path od-fill">' + esc(p) + '</span>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="dir-pick-remove" data-id="' + esc(p) + '">移除</button></div>';
        }).join('') + '</div>';
    }
    if (sug.length) {
      html += '<div class="fld"><span style="font-size:var(--text-sm);font-weight:600">同一工作区的相关仓库</span>' +
        '<p class="help">来自已发布系统地图与本机 team.md，勾选后新会话可以同时访问这些目录。</p>' +
        sug.map(function (x) {
          var on = !!x.local && picked.indexOf(x.local) >= 0;
          return '<label class="c4-check"><input type="checkbox" name="sessExtra" value="' + esc(x.local || '') + '"' +
            (on ? ' checked' : '') + (x.local ? '' : ' disabled') + '>' +
            esc(x.name) + ' · ' + esc(x.kind) + (x.local ? '' : ' · 本机未克隆') + '</label>';
        }).join('') + '</div>';
    }
    put(mount, html);
  }

  /* ═══════════ 模块 B:自动上下文 / 本机记忆 / 跨机引用(HC-233) ═══════════ */
  function ctxFor(s) {
    var rules = [], index = [];
    var dirs = (s.repos || []).map(function (r) { return r.name; });
    state.knowledge.filter(function (k) { return s.team && k.ws === s.team; }).forEach(function (k) {
      if (!(!k.applies || k.applies === '全团队' || dirs.indexOf(k.applies) >= 0)) return;
      (k.level === 'rule' ? rules : index).push(k);
    });
    var chars = index.reduce(function (n, k) { return n + String(k.title || '').length + String(k.sum || '').length; }, 0);
    return { rules: rules, index: index, kib: Math.max(1, Math.ceil(chars / 1024)) };
  }
  function contextBar(s) {
    if (!s || !s.team || !teamRole(s.team, ME)) return '';
    var c = ctxFor(s);
    var conflicts = MEM.personal.filter(function (m) { return !!m.conflict; }).length;
    var open = !!state.ctxOpen;
    var preview = '<div class="ctx-drawer">' +
      '<div class="ctx-drawer-grid">' +
        '<div class="ctx-item"><span class="ci-t">规约直带（' + c.rules.length + '）</span>' +
          '<span class="ci-b">' + (c.rules.length ? c.rules.map(function (k) { return esc(k.title); }).join('、') : '当前目录无命中规约') + '</span></div>' +
        '<div class="ctx-item"><span class="ci-t">知识索引 & 本机记忆</span>' +
          '<span class="ci-b">目录 ' + c.index.length + ' 条（' + c.kib + ' KiB）· team.md ' + MEM.team.length + ' / personal.md ' + MEM.personal.length + (conflicts ? '（' + conflicts + ' 处映射待对齐）' : '') + '</span></div>' +
      '</div>' +
      '<div class="c4-bar">' +
        journeyBtn('ctx-detail', '查看全部材料详情', '') +
        journeyBtn('ctx-memory', conflicts ? '纠正记忆冲突' : '检查本机记忆', 'personal', conflicts > 0) +
        journeyBtn('dir-menu', '管理附加目录', '') +
        '<span class="meta" style="margin-left:auto">仅随请求发给本机 Agent，不改写原始对话</span>' +
      '</div></div>';
    return '<div class="ctx-inline">' +
      '<button type="button" class="c4-context" data-act="ctx-open" aria-expanded="' + (open ? 'true' : 'false') + '" title="展开或收起本轮自动上下文明细">' + icon('book', 12) +
        '<span><strong>规约直带</strong> (' + c.rules.length + ')</span><span aria-hidden="true">·</span>' +
        '<span><strong>知识标题目录</strong> (' + c.index.length + ' 条 / ' + c.kib + ' KiB)</span><span aria-hidden="true">·</span>' +
        '<span><strong>本机记忆</strong></span>' +
        (conflicts ? '<span class="c4-ctx-warn">' + conflicts + ' 处记忆冲突</span>' : '') +
        '<span class="ctx-chev" style="margin-left:auto" aria-hidden="true">' + icon('chev-right', 11) + '</span>' +
      '</button>' +
      '<div class="ctx-collapse" data-open="' + (open ? '1' : '0') + '"' + (open ? '' : ' aria-hidden="true"') + '><div class="ctx-collapse-inner">' + preview + '</div></div>' +
    '</div>';
  }
  function ctxBody(s) {
    var c = ctxFor(s);
    return '<div class="c4-panel">' +
      '<p class="meta">只有绑定团队上下文的会话才附带自动材料；这个会话的团队是 ' + esc(wsById(s.team).name) + '。</p>' +
      '<p class="set-section-title" style="margin:0;padding:0">规约直带（' + c.rules.length + '）</p>' +
      '<p class="k-note">范围匹配时正文每轮直带。</p>' +
      (c.rules.length ? '<div class="ctx-list">' + c.rules.map(function (k) {
        return '<div class="ctx-item"><span class="ci-t">' + esc(k.title) + ' ' + esc(k.version) + '</span>' +
          '<span class="ci-b">' + esc(k.applies) + ' · ' + esc(String(k.body || k.sum).slice(0, 90)) + '…</span></div>';
      }).join('') + '</div>' : '<p class="meta">没有命中当前目录范围的规约。</p>') +
      '<p class="set-section-title">知识标题目录（' + c.index.length + ' 条 / ' + c.kib + ' KiB）</p>' +
      (c.index.length ? '<div class="ctx-list">' + c.index.map(function (k) {
        return '<div class="ctx-item"><span class="ci-t">' + esc(k.title) + ' ' + esc(k.version) + '</span>' +
          '<span class="ci-b">' + esc(LEVEL_TEXT[k.level] || '经验') + ' · ' + esc(k.applies) + ' · 标题目录 + 按需读取</span></div>';
      }).join('') + '</div>' : '<p class="meta">没有可索引的条目。</p>') +
      '<p class="set-section-title">本机记忆</p>' +
      '<p class="meta">team.md ' + MEM.team.length + ' 条 · personal.md ' + MEM.personal.length + ' 条（只在本机，不上传云端）</p>' +
      '<div class="c4-bar">' + journeyBtn('ctx-memory', '检查与纠正本机记忆', '', true) + '</div>' +
      '<div class="k-warn"><span>用户草稿、消息显示和云端上传始终保留原始文字，自动材料仅发给本机 Agent。</span></div>' +
    '</div>';
  }
  function memoryBody(tab) {
    var list = MEM[tab] || [];
    return '<div class="c4-panel">' +
      '<div class="seg" role="tablist" aria-label="本机记忆文件">' +
        [['team', 'team.md'], ['personal', 'personal.md']].map(function (t) {
          return '<button type="button" role="tab" class="' + (tab === t[0] ? 'is-active' : '') + '" data-act="mem-tab" data-id="' + t[0] +
            '" aria-selected="' + (tab === t[0]) + '">' + t[1] + '</button>';
        }).join('') + '</div>' +
      (list.length ? list.map(function (m) {
        return '<div class="ctx-item"><div class="c4-row"><span class="ci-t od-fill">' + esc(m.key) + '</span>' +
          journeyBtn('mem-remove', '移除', tab + ':' + m.id) + '</div>' +
          '<span class="ci-b">' + esc(m.text) + '</span><span class="k-note">' + esc(m.src) + '</span>' +
          (m.conflict ? '<div class="k-warn"><span>与已发布系统地图冲突：' + esc(m.conflict) + '</span><div class="c4-bar">' +
            journeyBtn('mem-fix', '按系统地图更新', m.id) + journeyBtn('mem-propose', '发起地图修订提议', m.id) + '</div></div>' : '') +
          '</div>';
      }).join('') : '<p class="meta">这个文件还没有条目。</p>') +
      '<div class="fld"><label for="memKey">新增条目</label>' +
        '<input id="memKey" type="text" placeholder="例如：pay-gateway 本机未克隆">' +
        '<input id="memText" type="text" placeholder="写清关系和结论"></div>' +
      '<div class="c4-bar">' + journeyBtn('mem-add', '保存到 ' + tab + '.md', '', true) +
        journeyBtn('mem-collect', '将本机新增关系整理为系统地图提议') + '</div>' +
    '</div>';
  }
  function openMemory(tab) {
    state.memTab = tab || state.memTab || 'team';
    journeyDialog('本机记忆检查与纠正', memoryBody(state.memTab), '', 'team.md / personal.md · 只在本机，不上传云端');
  }
  function findRef(id) {
    var hit = null;
    state.sessions.forEach(function (s) {
      (s.msgs || []).forEach(function (m) { if (!hit && m.w === 'reference' && m.id === id) hit = m; });
    });
    return hit;
  }
  function referenceCard(m) {
    var linked = m.state === 'linked';
    return '<div class="tl"><div class="tl-body"><div class="c4-card">' +
      '<div class="c4-bar" style="justify-content:space-between">' +
        '<span class="kb ' + (linked ? 'is-rule' : 'is-pending') + '">' + (linked ? '已解析到本机' : '本机未关联') + '</span>' +
        '<span class="meta">来自 ' + esc(PEOPLE[m.from] ? PEOPLE[m.from].name : '队友') + ' 的跨机引用</span>' +
      '</div>' +
      '<p class="meta">原文原样保留：</p>' +
      '<span class="ref-raw">' + esc(m.raw) + '</span>' +
      (m.said ? '<p class="meta">口语原话：' + esc(m.said) + '</p>' : '') +
      (linked
        ? '<span class="ref-arrow">↓ 通过 team.md / personal.md 解析到本机</span>' +
          '<span class="ref-local">' + esc(m.local) + '</span>' +
          '<p class="k-note">' + esc(m.verify || '本机映射已校验') + '</p>'
        : '<p class="k-note">' + esc(m.repo || '目标工程') + ' 本机未克隆或未映射到目录，先关联本机目录再读文件。</p>') +
      '<div class="c4-bar">' + (linked
        ? journeyBtn('ref-open', '打开本机文件', m.id) + journeyBtn('ref-relink', '重新选择目录', m.id) + journeyBtn('ref-remove', '移除该条记录', m.id)
        : journeyBtn('ref-link', '关联本机目录', m.id, true) + journeyBtn('ref-remove', '移除该条记录', m.id)) +
      '</div></div></div></div>';
  }
  function pushProposal(p) {
    p.id = p.id || ('pr-' + Date.now() + '-' + state.proposals.length);
    p.time = p.time || '刚刚';
    p.author = p.author || ME;
    p.status = 'pending';
    state.proposals.unshift(p);
    return p;
  }
  function citePeer(copy) {
    if (!copy) return;
    var proj = projById(copy.proj);
    var ws = proj ? proj.ws : state.ws;
    var s = addSession('引用 ' + (PEOPLE[copy.owner] ? PEOPLE[copy.owner].name : '队友') + ' 的《' + copy.title + '》', ws,
      '~/work/harness/' + baseName((proj && proj.repo) || 'workspace'), null, []);
    s.msgs = [
      { w: 'reference', id: 'ref-' + Date.now(), from: copy.owner, raw: copy.title, said: copy.brief || '队友的只读快照',
        repo: (proj && proj.repo) || '', local: s.mainDir, state: 'linked', verify: '只读快照已引用到我的本机会话，队友机器不会被访问' },
      { w: 'sys', text: '引用的正文是定稿快照，不含队友草稿、自动材料与本机记忆。' },
      { w: ME, time: '刚刚', text: '接着这份快照在本机继续推进。' }
    ];
    state.session = s.id;
    state.cross = null;
    state.view = 'chat';
    state.preview = null;
    state.shouldScrollEnd = true;
    syncSpaceFor(s);
    render();
    toast('已引用到个人空间的本机会话');
  }

  /* ═══════════ 模块 C:团队知识分级 / 审核 / 系统地图(HC-241 + HC-243) ═══════════ */
  function publishedKnowledge() {
    return state.knowledge.filter(function (k) { return k.ws === state.ws; });
  }
  function pendingProposals() {
    return state.proposals.filter(function (p) { return p.status === 'pending'; });
  }
  function proposalById(id) { return state.proposals.filter(function (p) { return p.id === id; })[0]; }
  function kTitle(p) {
    var t = p.targetId ? state.knowledge.filter(function (k) { return k.id === p.targetId; })[0] : null;
    return (t && t.title) || p.title || '未命名提议';
  }
  function kBadges(k) {
    return '<span class="kb is-' + (k.level || 'exp') + '" title="' + esc(LEVEL_NOTE[k.level || 'exp']) + '">' + esc(LEVEL_TEXT[k.level || 'exp'] || '经验') + '</span>' +
      '<span class="kb is-applies" title="适用范围">' + esc(k.applies || '全团队') + '</span>' +
      '<span class="kb">' + esc(k.version) + '</span>';
  }
  function diffHtml(rows) {
    return '<div class="diff">' + (rows || []).map(function (d) {
      var cls = d.t === 'add' ? 'is-add' : (d.t === 'del' ? 'is-del' : 'is-ctx');
      return '<div class="diff-row ' + cls + '"><span class="d-sign">' + (d.t === 'add' ? '+' : (d.t === 'del' ? '−' : ' ')) + '</span><span>' + esc(d.x) + '</span></div>';
    }).join('') + '</div>';
  }
  function mergeBody(k, p) {
    var lines = String(k.body || '').split('\n');
    var dels = p.diff.filter(function (d) { return d.t === 'del'; }).map(function (d) { return d.x; });
    var adds = p.diff.filter(function (d) { return d.t === 'add'; }).map(function (d) { return d.x; });
    var out = [], used = [];
    lines.forEach(function (line) {
      if (dels.some(function (d) { return line.trim() === d.trim(); })) {
        adds.forEach(function (a) { if (used.indexOf(a) < 0) { out.push(a); used.push(a); } });
        return;
      }
      out.push(line);
    });
    adds.forEach(function (a) { if (used.indexOf(a) < 0) out.push(a); });
    return out.join('\n');
  }
  function wsMapRepos() {
    var allow = WS_REPOS[state.ws] || [];
    return SYS_MAP.repos.filter(function (r) { return allow.indexOf(r.name) >= 0; });
  }
  function sysMapSvg() {
    var repos = wsMapRepos(), cols = Math.min(4, Math.max(2, repos.length));
    var W = Math.max(660, cols * 220), H = 64 + Math.ceil(repos.length / cols) * 144;
    var pos = {};
    repos.forEach(function (r, i) {
      pos[r.name] = { x: 112 + (i % cols) * 212, y: 88 + Math.floor(i / cols) * 144 };
    });
    var defs = '<defs><marker id="mapArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M1 2l7 3-7 3z" fill="var(--meta)"/></marker>' +
      '<marker id="mapArrowHi" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M1 2l7 3-7 3z" fill="var(--accent)"/></marker></defs>';
    var edges = [];
    var picked = state.selectedMapRepo;
    repos.forEach(function (r) {
      var a = pos[r.name];
      r.rel.forEach(function (rel, ri) {
        var b = pos[rel.to];
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        var ux = dx / len, uy = dy / len;
        var sx, sy, ex, ey, cx, cy;
        if (Math.abs(dy) < 10 && Math.abs(dx) > 260) {
          var dirX = dx > 0 ? 1 : -1;
          sx = a.x + dirX * 22; sy = a.y - 22;
          ex = b.x - dirX * 22; ey = b.y - 22;
          cx = (sx + ex) / 2; cy = a.y - 74 - (ri % 2) * 14;
        } else {
          sx = a.x + ux * 68; sy = a.y + uy * 20;
          ex = b.x - ux * 74; ey = b.y - uy * 22;
          var arc = Math.abs(dy) < 10 ? -28 : ((ri % 2 === 0 ? 1 : -1) * 24);
          cx = (sx + ex) / 2 - uy * arc; cy = (sy + ey) / 2 + ux * arc;
        }
        var hi = picked && (picked === r.name || picked === rel.to);
        edges.push('<path d="M' + Math.round(sx) + ' ' + Math.round(sy) + ' Q' + Math.round(cx) + ' ' + Math.round(cy) + ' ' + Math.round(ex) + ' ' + Math.round(ey) + '"' +
          ' fill="none" stroke="' + (hi ? 'var(--accent)' : 'var(--border-strong)') + '" stroke-width="' + (hi ? '1.8' : '1.25') + '"' +
          (rel.sure ? '' : ' stroke-dasharray="4 3"') + ' marker-end="url(#' + (hi ? 'mapArrowHi' : 'mapArrow') + ')"' +
          (picked && !hi ? ' opacity="0.28"' : '') + '/>');
      });
    });
    var nodes = repos.map(function (r) {
      var p = pos[r.name], local = !!r.local, isPicked = picked === r.name;
      return '<g class="map-node' + (isPicked ? ' is-picked' : '') + '" data-act="map-node" data-id="' + esc(r.name) + '">' +
        '<rect x="' + (p.x - 76) + '" y="' + (p.y - 22) + '" width="152" height="44" rx="8" fill="var(--surface)" stroke="' +
          (local ? 'var(--border-strong)' : 'var(--border)') + '"' + (local ? '' : ' stroke-dasharray="3 3"') + '/>' +
        '<text x="' + p.x + '" y="' + (p.y - 2) + '" text-anchor="middle" font-size="11.5" font-weight="600" font-family="var(--font-mono)" fill="var(--fg)">' + esc(r.name) + '</text>' +
        '<text x="' + p.x + '" y="' + (p.y + 13) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' +
          (local ? '已映射' : '本机未克隆') + '</text></g>';
    });
    return '<svg class="map-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Workspace 仓库关系图">' + defs + edges.join('') + nodes.join('') + '</svg>';
  }
  function sysMapHtml() {
    var repos = wsMapRepos();
    var picked = state.selectedMapRepo;
    function rowOf(r, rel, showHead) {
      var hi = picked && (picked === r.name || (rel && rel.to === picked));
      return '<tr class="' + (hi ? 'is-hi' : '') + '"><td>' + (showHead ? '<strong>' + esc(r.name) + '</strong>' : '') + '</td>' +
        '<td>' + (showHead ? esc(r.duty) : '') + '</td>' +
        '<td>' + (rel ? esc(rel.kind) + ' → ' + esc(rel.to) : '—') + '</td>' +
        '<td>' + (rel ? (rel.ev ? '<span class="ev">' + esc(rel.ev) + '</span>' : '<span class="est">推测</span>') : '—') + '</td>' +
        '<td>' + (showHead ? (r.local ? '<span class="kb">已映射</span> <span class="ev">' + esc(r.local) + '</span>'
          : '<span class="kb is-pending">本机未克隆</span>') : '') + '</td></tr>';
    }
    var rows = [];
    repos.forEach(function (r) {
      var allow = WS_REPOS[state.ws] || [];
      var rels = r.rel.filter(function (rel) { return allow.indexOf(rel.to) >= 0; });
      if (!rels.length) rows.push(rowOf(r, null, true));
      rels.forEach(function (rel, ri) { rows.push(rowOf(r, rel, ri === 0)); });
    });
    return '<div class="c4-panel">' +
      '<div class="c4-row"><span class="od-fill od-stack"><span><strong>团队系统地图</strong> ' + esc(SYS_MAP.version) + ' · ' + esc(SYS_MAP.status) + '</span>' +
        '<span class="meta">' + esc(PEOPLE[SYS_MAP.publisher] ? PEOPLE[SYS_MAP.publisher].name : SYS_MAP.publisher) + ' 发布 · ' +
        esc(SYS_MAP.updated) + ' 更新 · 当前 Workspace：' + esc(curWs().name) + '</span></span>' +
        (teamRole(state.ws, ME) ? journeyBtn('map-analyze', '分析仓库关系', '', false) : '') + '</div>' +
      '<div class="map-legend"><span>实线箭头：代码证据已确认</span><span>虚线箭头：推测待核实</span><span>点选节点可联动高亮下方明细' +
        (picked ? ' · <button type="button" class="btn btn-ghost btn-sm" data-act="map-node" data-id="' + esc(picked) + '">清除筛选(' + esc(picked) + ')</button>' : '') + '</span></div>' +
      '<div class="map-wrap">' + sysMapSvg() + '</div>' +
      '<div class="map-wrap"><table class="map-table"><thead><tr><th>仓库</th><th>职责</th><th>关系</th><th>证据文件</th><th>personal.md 本机状态</th></tr></thead>' +
        '<tbody>' + rows.join('') + '</tbody></table></div>' +
      '<p class="k-note">证据文件路径为空的关系标为「推测」；本机未克隆的仓库只提示，不远程读取文件。</p>' +
    '</div>';
  }
  function proposalDetailHtml(p, admin) {
    var target = p.targetId ? state.knowledge.filter(function (k) { return k.id === p.targetId; })[0] : null;
    return '<div class="od-row" style="flex-wrap:wrap;--od-gap:8px">' +
        '<span class="kb ' + (p.status === 'rejected' ? 'is-pending' : 'is-rule') + '">' + (p.status === 'rejected' ? '已退回' : '待审核') + '</span>' +
        '<span class="kb is-' + (p.level || 'exp') + '">' + esc(LEVEL_TEXT[p.level || 'exp']) + '</span>' +
        '<span class="kb is-applies">' + esc(p.applies || '全团队') + '</span>' +
        '<span class="meta">' + esc(PEOPLE[p.author] ? PEOPLE[p.author].name : p.author) + ' 提议 · ' + esc(p.time) + '</span>' +
      '</div>' +
      '<h2>' + esc(kTitle(p)) + (target ? ' · 补充到已有条目' : ' · 新增条目') + '</h2>' +
      '<p class="k-note">来源：' + esc(p.source || '本机会话') + '</p>' +
      diffHtml(p.diff) +
      (p.reason ? '<div class="k-warn"><span>退回理由：' + esc(p.reason) + '</span></div>' : '') +
      '<p class="k-note">批准前这条内容不会进入任何人的 Agent，只在本机待审核队列里。</p>' +
      (p.status === 'pending' && admin
        ? '<div class="c4-bar">' + journeyBtn('prop-approve', '批准发布', p.id, true) +
            journeyBtn('prop-approve-mod', '修改后批准', p.id) + journeyBtn('prop-reject', '退回', p.id) + '</div>'
        : '') +
      (p.status === 'pending' && !admin ? '<p class="meta">审核动作只对 Workspace 管理员开放。</p>' : '') +
      (p.status === 'rejected'
        ? '<div class="c4-bar">' + journeyBtn('prop-resubmit', '修改后重新提交', p.id, true) + '</div>' : '');
  }
  function reviewQueueHtml() {
    var admin = isAdmin(state.ws);
    var list = state.proposals.filter(function (p) { return p.status !== 'published' && (state.kscope !== 'mine' || p.author === ME); });
    if (!list.length) {
      return emptyBlock('没有待审核提议', '本机 Agent 的定期整理和会话沉淀都会先落到这里。',
        admin ? journeyBtn('organize', '让 Agent 整理知识库', '', true) : '');
    }
    if (!list.some(function (p) { return p.id === state.propSel; })) state.propSel = list[0].id;
    var cur = list.filter(function (p) { return p.id === state.propSel; })[0] || list[0];
    var rows = list.map(function (p) {
      return '<button type="button" class="k-row ' + (p.id === cur.id ? 'is-active' : '') + '" data-act="prop-open" data-id="' + p.id + '">' +
        '<span class="kr-title">' + esc(kTitle(p)) + '</span>' +
        '<span class="kr-meta"><span class="kb ' + (p.status === 'rejected' ? 'is-pending' : '') + '">' +
          (p.status === 'rejected' ? '已退回' : '待审核') + '</span>' +
          esc(PEOPLE[p.author] ? PEOPLE[p.author].name : p.author) + '<span>·</span><span>' + esc(p.time) + '</span></span></button>';
    }).join('');
    return '<div class="review-layout"><div class="k-side" role="list">' + rows + '</div>' +
      '<article class="k-doc">' + proposalDetailHtml(cur, admin) + '</article></div>';
  }
  var DRAFT_MODES = [
    ['supplement', '补充到已有条目'], ['new', '新增经验条目'], ['conflict', '冲突修订']
  ];
  function draftPreview(mode) {
    if (mode === 'new') {
      return { title: '退款单落库顺序与补偿窗口', level: 'exp', applies: 'order-service', source: '会话「幂等键过期策略」 · 本机 Agent 检索到已有 7 条知识',
        diff: [ { t: 'add', x: '1. 退款单必须先落库再调用渠道，渠道回调只改状态、不回写金额。' },
                { t: 'add', x: '2. 补偿窗口 5 分钟内重试，超过窗口转入对账差异单，不再直接重试渠道。' } ] };
    }
    if (mode === 'conflict') {
      return { title: '拆分支付状态机与回调时序 ADR', level: 'rule', applies: 'checkout-split', source: '会话「支付状态机回调时序核对」 · 与已发布 ADR v3.0 冲突',
        diff: [ { t: 'ctx', x: '【决策】状态迁移仅允许 PAID → REFUNDING / PARTIAL_REFUNDED。' },
                { t: 'del', x: '- callback/refund.ts 与 job/compensate.ts 必须共用同一套 idempotent(orderId, refundNo) 闸门。' },
                { t: 'add', x: '- callback/refund.ts、job/compensate.ts 与人工补偿入口共用同一套 idempotent(orderId, refundNo) 闸门。' },
                { t: 'add', x: '- 补偿任务不得跳过状态校验直接改库，违反时以本条为準。' } ] };
    }
    return { title: '分布式幂等键设计规范', level: 'rule', applies: '全团队', source: '会话「支付状态机回调时序核对」 · 本机 Agent 检索到已有 7 条知识',
      diff: [ { t: 'ctx', x: '2. 有效期：支付与退款链路统一 24h，查询类链路缩短为 2h。' },
              { t: 'del', x: '3. 重入语义：并发执行中返回 409 PROCESSING；已完成态幂等返回首次成功载荷，禁止二次触发下游网关。' },
              { t: 'add', x: '3. 重入语义：并发执行中返回 409 PROCESSING；已完成态幂等返回首次成功载荷，禁止二次触发下游网关。' },
              { t: 'add', x: '4. 回调入口与补偿任务必须共用同一把键（orderId + refundNo），任一侧不得跳过闸门。' },
              { t: 'add', x: '5. 幂等回归至少覆盖重复回调、并发投递、0 元券三类边界。' } ] };
  }
  function draftBody() {
    var d = draftPreview(state.propMode);
    return '<div class="c4-panel">' +
      '<div class="seg" role="tablist" aria-label="起草方式">' + DRAFT_MODES.map(function (m) {
        return '<button type="button" role="tab" class="' + (state.propMode === m[0] ? 'is-active' : '') + '" data-act="prop-mode" data-id="' + m[0] +
          '" aria-selected="' + (state.propMode === m[0]) + '">' + esc(m[1]) + '</button>';
      }).join('') + '</div>' +
      '<p class="meta">本机 Agent 已读完当前会话并检索过已有知识。' + esc(d.source) + '</p>' +
      '<div class="fld"><label for="propTitleEdit">条目名称' + (state.propMode === 'supplement' ? '（将升级到 v2.2）' : '') + '</label>' +
        '<input id="propTitleEdit" type="text" value="' + esc(d.title) + '"></div>' +
      diffHtml(d.diff) +
      '<div class="c4-bar">' +
        '<label class="c4-check" style="gap:6px">级别' +
          '<select id="propLevel" class="c4-select">' + [['exp', '经验（标题目录 + 按需读取）'], ['term', '术语（标题目录 + 按需读取）'], ['rule', '建议升为规约（正文每轮直带）']].map(function (o) {
            return '<option value="' + o[0] + '"' + (o[0] === d.level ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
          }).join('') + '</select></label>' +
        '<label class="c4-check" style="gap:6px">适用范围' +
          '<select id="propApplies" class="c4-select">' + ['全团队'].concat(repoNames(state.ws)).map(function (r) {
            return '<option value="' + esc(r) + '"' + (r === d.applies ? ' selected' : '') + '>' + esc(r) + '</option>';
          }).join('') + '</select></label>' +
      '</div>' +
      '<p class="k-note">提交后进入待审核队列；管理员批准前不会出现在任何人的 Agent 上下文里。</p>' +
    '</div>';
  }
  function openDraft(mode, targetId) {
    if (!curWs().id) { toast('未加入团队时不能提交团队知识'); return; }
    state.propMode = mode || 'supplement';
    var t = state.knowledge.filter(function (k) { return k.id === (targetId || 'k2'); })[0];
    state.propTarget = t ? t.id : null;
    if (state.propMode === 'new') state.propTarget = null;
    journeyDialog('沉淀为团队知识', draftBody(), journeyBtn('prop-submit', '提交为待审核', '', true),
      '来自本机会话 · 批准前不进入任何人的 Agent');
  }
  function submitProposal() {
    var lv = $('#propLevel'), ap = $('#propApplies'), ti = $('#propTitleEdit');
    var d = draftPreview(state.propMode);
    pushProposal({
      kind: state.propMode,
      targetId: state.propMode === 'new' ? null : state.propTarget,
      title: (ti && ti.value.trim()) ? ti.value.trim() : d.title,
      level: lv ? lv.value : d.level,
      applies: ap ? ap.value : d.applies,
      source: d.source,
      diff: d.diff
    });
    openInbox('sent', 'prop:' + state.proposals[0].id, true);
    toast('已提交 · 可在 Inbox「我发起的」跟踪审核进度；批准前不会进入任何人的 Agent');
  }
  function applyProposal(p, edited) {
    if (p.kind === 'map') {
      SYS_MAP.version = bumpVersion(SYS_MAP.version);
      SYS_MAP.updated = '刚刚';
      SYS_MAP.publisher = ME;
      p.status = 'published';
      return '系统地图';
    }
    var target = p.targetId ? state.knowledge.filter(function (k) { return k.id === p.targetId; })[0] : null;
    if (target) {
      target.body = edited || (p.kind === 'new'
        ? p.diff.filter(function (d) { return d.t === 'add'; }).map(function (d) { return d.x; }).join('\n')
        : mergeBody(target, p));
      target.version = bumpVersion(target.version);
      target.updated = '刚刚';
      target.hist = target.hist || [];
      target.hist.push({ who: p.author, act: '提议', ver: target.version, date: '刚刚' });
      target.hist.push({ who: ME, act: '审核通过', ver: target.version, date: '刚刚' });
      if (p.level) target.level = p.level;
      if (p.applies) target.applies = p.applies;
      p.status = 'published';
      return '《' + target.title + '》' + target.version;
    }
    var nid = 'k-' + Date.now();
    state.knowledge.unshift({
      id: nid, ws: propWs(p), scope: 'workspace', level: p.level || 'exp', applies: p.applies || '全团队',
      title: p.title, author: p.author, version: 'v1.0', updated: '刚刚',
      sum: (p.diff.filter(function (d) { return d.t === 'add'; })[0] || {}).x || p.title,
      body: edited || p.diff.filter(function (d) { return d.t === 'add'; }).map(function (d) { return d.x; }).join('\n'),
      hist: [{ who: p.author, act: '提议', ver: 'v1.0', date: '刚刚' }, { who: ME, act: '审核通过', ver: 'v1.0', date: '刚刚' }]
    });
    p.status = 'published';
    return '《' + p.title + '》v1.0';
  }
  function approveProposal(p, edited) {
    var label = applyProposal(p, edited);
    closeDialog('dlgJourney');
    render();
    toast('已批准发布 ' + label + ' · 已推送 knowledge.updated 刷新目录');
  }
  function openApproveEdit(id) {
    var p = proposalById(id);
    if (!p) return;
    var target = p.targetId ? state.knowledge.filter(function (k) { return k.id === p.targetId; })[0] : null;
    var body = p.kind === 'new'
      ? p.diff.filter(function (d) { return d.t === 'add'; }).map(function (d) { return d.x; }).join('\n')
      : (target ? mergeBody(target, p) : '');
    journeyDialog('修改后批准', '<div class="c4-panel"><p class="meta">批准前可以改正文，改动会一起记进新版本。</p>' +
      '<div class="fld"><label for="propEditBody">正文</label><textarea id="propEditBody" rows="8">' + esc(body) + '</textarea></div></div>',
      journeyBtn('prop-approve-mod-ok', '按修改内容发布', p.id, true));
  }
  function openReject(id) {
    var p = proposalById(id);
    if (!p) return;
    journeyDialog('退回提议', '<div class="c4-panel"><p class="meta">退回项会保留在队列里，提议人可以修改后重新提交。</p>' +
      '<div class="fld"><label for="propReason">退回理由</label><input id="propReason" type="text" placeholder="例如：适用范围写成了本机目录，请改成仓库名"></div></div>',
      journeyBtn('prop-reject-ok', '确认退回', p.id, true));
  }
  function organize() {
    if (!isAdmin(state.ws)) { toast('定期整理只对 Workspace 管理员开放'); return; }
    if (proposalById('pr-organize')) { openInbox('todo', 'prop:pr-organize'); toast('整理提议已经在收件箱里'); return; }
    pushProposal({
      id: 'pr-organize', kind: 'new', level: 'exp', applies: '全团队',
      title: '本机 Agent 定期整理：重复条目合并建议',
      source: '本机 Agent 扫描 ' + publishedKnowledge().length + ' 条已发布知识，发现 2 条幂等键相关条目可合并',
      diff: [ { t: 'add', x: '1. 幂等键相关条目统一以《分布式幂等键设计规范》为主条目，其余条目只登记差异点。' },
              { t: 'add', x: '2. 回调、补偿、人工操作三条入口必须引用同一把键，TTL 统一 24h。' } ]
    });
    openInbox('todo', 'prop:pr-organize');
    toast('已生成整理提议 · 请在 Inbox 审核');
  }
  function analyzeMap() {
    if (!teamRole(state.ws, ME)) { toast('加入 Workspace 后才能分析仓库关系'); return; }
    var repos = wsMapRepos();
    var scanned = repos.filter(function (r) { return !!r.local; });
    var miss = repos.filter(function (r) { return !r.local; });
    var rows = [];
    scanned.forEach(function (r) {
      r.rel.forEach(function (rel) {
        rows.push({ t: 'add', x: r.name + ' → ' + rel.to + '（' + rel.kind + '）证据 ' + (rel.ev || '无，需补证据') + (rel.sure ? '' : ' · 推测待确认') });
      });
    });
    pushProposal({
      kind: 'map', level: 'map', applies: '全团队',
      title: '系统地图增量：本机副本扫描结果',
      source: '只扫描本机已有副本 ' + scanned.length + ' 个仓库；未克隆的 ' + (miss.length ? miss.map(function (r) { return r.name; }).join('、') : '无') + ' 保持原关系不动',
      diff: rows.length ? rows : [{ t: 'ctx', x: '本机副本没有新增关系。' }]
    });
    openInbox(isAdmin(state.ws) ? 'todo' : 'sent', 'prop:' + state.proposals[0].id, true);
    toast('已生成增量提议（只覆盖本机副本，不删已有关系）');
  }
  function initContext() {
    var s1 = state.sessions.filter(function (s) { return s.id === 's1'; })[0];
    if (s1 && s1.msgs.length > 2) {
      var at = s1.msgs.length - 2;
      s1.msgs.splice(at, 0,
        { w: 'tool', tool: 'read_team_knowledge', detail: 'knowledge:k2:v2.1', badge: '固定版本', tone: 'ok', knowledge: 'k2', version: 'v2.1',
          out: '1. Key 格式：pay:{idem}:<bizType>:<orderId>:<subNo>\n2. 有效期：支付与退款链路统一 24h' },
        { w: 'tool', tool: 'query_project_memory', detail: 'team.md', badge: '命中 2 条', tone: 'ok',
          out: 'checkout-split → common-proto   [team.md]\nbilling ≡ ledger-service       [team.md]' },
        { w: 'tool', tool: 'propose_project_memory_update', detail: 'team.md', badge: 'pending → 已写入', tone: 'ok',
          out: '+ 回调与补偿任务共用同一把幂等键（orderId + refundNo）' },
        { w: 'agent', model: 'claude-sonnet-4', time: '10:16', blocks: [
          { t: 'p', text: '本轮只带了 1 条规约正文和 2 条本机记忆；你的原始草稿与消息没有改写，自动材料只发给本机 Agent。' }
        ] },
        { w: 'sys', text: '项目记忆已更新 · 已写入 team.md' }
      );
    }
    var ref = addSession('跨机引用：账务工程的 retry 配置', 'ws-base', '~/work/harness/ledger-service', null, []);
    ref.time = '26 分钟前';
    ref.msgs = [
      { w: 'sys-divider', label: '来自沈北辰的跨机引用 · 原文未改写' },
      { w: ME, time: '14:02', text: '北辰在他机器上指的是「旁边那个账务工程」，我这边没有 billing 这个目录。' },
      { w: 'reference', id: 'ref-1', from: 'shenbeichen', raw: '../billing/src/config.ts', said: '旁边那个账务工程里 config.ts 的 retry 配置',
        repo: 'billing', local: '~/work/harness/ledger-service/src/config.ts', state: 'linked',
        verify: 'upstream 校验通过：本机 fork 与 pay/billing 同源，分支 feat/ledger-retry' },
      { w: 'agent', model: 'claude-sonnet-4', time: '14:03', blocks: [
        { t: 'p', text: '按 team.md 把 `billing` 映射到本机 `~/work/harness/ledger-service`，并核对 personal.md 里的 fork 来源；主目录仍是 ledger-service，没有改动。' }
      ] },
      { w: 'reference', id: 'ref-2', from: 'wangdalin', raw: 'pay-gateway/refund.proto', said: '渠道那边的退款回调契约',
        repo: 'pay-gateway', local: '', state: 'unlinked', verify: '' },
      { w: 'sys', text: '本机未克隆的工程只提示关系，不远程读文件；关联目录只写入 personal.md。' }
    ];
  }
  function initKnowledge() {
    var LEVEL = { k1: 'rule', k2: 'rule', k3: 'term', k4: 'exp', k5: 'exp', k6: 'exp', k7: 'exp' };
    var APPLY = { k1: '全团队', k2: '全团队', k3: '全团队', k4: 'checkout-split', k5: 'bill-export', k6: 'idempotency', k7: 'risk-sandbox' };
    state.knowledge.forEach(function (k) {
      k.scope = 'workspace';
      k.ws = k.ws || 'ws-base';
      k.level = k.level || LEVEL[k.id] || 'exp';
      k.applies = k.applies || APPLY[k.id] || '全团队';
      k.hist = k.hist || [
        { who: k.author, act: '撰写', ver: 'v1.0', date: k.updated },
        { who: 'wangdalin', act: '审核通过', ver: k.version, date: k.updated }
      ];
    });
    state.proposals = [
      { id: 'pr1', kind: 'supplement', targetId: 'k2', level: 'rule', applies: '全团队', author: 'shenbeichen', time: '1 小时前', status: 'pending',
        source: '会话「支付状态机回调时序核对」 · 本机 Agent 检索到已有 7 条知识',
        diff: [ { t: 'ctx', x: '2. 有效期：支付与退款链路统一 24h，查询类链路缩短为 2h。' },
                { t: 'del', x: '3. 重入语义：并发执行中返回 409 PROCESSING；已完成态幂等返回首次成功载荷，禁止二次触发下游网关。' },
                { t: 'add', x: '3. 重入语义：并发执行中返回 409 PROCESSING；已完成态幂等返回首次成功载荷，禁止二次触发下游网关。' },
                { t: 'add', x: '4. 回调入口与补偿任务必须共用同一把键（orderId + refundNo），任一侧不得跳过闸门。' },
                { t: 'add', x: '5. 幂等回归至少覆盖重复回调、并发投递、0 元券三类边界。' } ] },
      { id: 'pr2', kind: 'new', targetId: null, level: 'exp', applies: 'order-service', author: 'yangkang', time: '3 小时前', status: 'pending',
        title: '退款单落库顺序与补偿窗口',
        source: '会话「对账补偿任务调度」 · 本机 Agent 已去重',
        diff: [ { t: 'add', x: '1. 退款单必须先落库再调用渠道，渠道回调只改状态、不回写金额。' },
                { t: 'add', x: '2. 补偿窗口 5 分钟内重试，超过窗口转入对账差异单。' } ] },
      { id: 'pr3', kind: 'new', targetId: null, level: 'exp', applies: '~/Documents/log-lab', author: 'fengxueming', time: '昨天', status: 'rejected',
        title: '本地日志脚本命名约定', reason: '适用范围写成本机目录了，请改成仓库名再提交。',
        source: '会话「本地日志分析脚本调试」',
        diff: [{ t: 'add', x: '1. 脚本统一放在 scripts/ 下，按 动词-对象.py 命名。' }] }
    ];
  }
  function handleKnowledge(act, id, el) {
    switch (act) {
      case 'knowledge-snapshot': {
        var kid = el && el.getAttribute('data-knowledge');
        var k = state.knowledge.filter(function (x) { return x.id === kid; })[0];
        if (!k) { toast('这条知识的固定版本已不可用'); return true; }
        state.kEdit = false;
        state.kSel = k.id;
        state.kscope = 'all';
        state.ws = k.ws || state.ws;
        goView('knowledge');
        closeDialog('dlgJourney');
        toast('已打开《' + k.title + '》固定版本 ' + k.version);
        return true;
      }
      case 'k-edit': {
        var kb = state.knowledge.filter(function (x) { return x.id === id; })[0];
        if (!kb) return true;
        if (!isAdmin(kb.ws)) { openDraft('conflict', kb.id); return true; }
        state.kEdit = true;
        render();
        var ke = $('#kEditArea');
        if (ke) { ke.focus(); ke.setSelectionRange(ke.value.length, ke.value.length); }
        return true;
      }
      case 'k-propose': { openDraft('conflict', id); return true; }
      case 'proposal-draft': { openDraft('supplement', id || 'k2'); return true; }
      case 'prop-mode': {
        state.propMode = id;
        if (state.propMode === 'new') state.propTarget = null;
        journeyDialog('沉淀为团队知识', draftBody(), journeyBtn('prop-submit', '提交为待审核', '', true),
          '来自本机会话 · 批准前不进入任何人的 Agent');
        return true;
      }
      case 'prop-submit': submitProposal(); return true;
      case 'prop-open': state.propSel = id; render(); return true;
      case 'prop-approve': {
        var p = proposalById(id);
        if (!p || !isAdmin(propWs(p))) { toast('审核动作只对所属 Workspace 管理员开放'); return true; }
        resolveInboxRowThen(function () { approveProposal(p); });
        return true;
      }
      case 'prop-approve-mod': openApproveEdit(id); return true;
      case 'prop-approve-mod-ok': {
        var pm = proposalById(id);
        var bodyEl = $('#propEditBody');
        if (!pm || !isAdmin(propWs(pm))) return true;
        approveProposal(pm, bodyEl ? bodyEl.value.trim() : '');
        return true;
      }
      case 'map-node': {
        state.selectedMapRepo = (state.selectedMapRepo === id ? null : id);
        renderStage();
        return true;
      }
      case 'prop-reject': openReject(id); return true;
      case 'prop-reject-ok': {
        var pr = proposalById(id);
        var reasonEl = $('#propReason');
        var reason = reasonEl ? reasonEl.value.trim() : '';
        if (!pr) return true;
        if (!reason) { showJourneyErr('请先填写退回理由，提议人会按此修改后重提。', reasonEl); return true; }
        pr.status = 'rejected';
        pr.reason = reason;
        closeDialog('dlgJourney');
        render();
        toast('已退回 · 提议人可修改后重新提交');
        return true;
      }
      case 'prop-resubmit': {
        var rs = proposalById(id);
        if (!rs) return true;
        rs.status = 'pending';
        rs.reason = '';
        rs.time = '刚刚';
        render();
        toast('已重新提交为待审核');
        return true;
      }
      case 'organize': organize(); return true;
      case 'map-analyze': analyzeMap(); return true;
      default: return false;
    }
  }
  function knowledgeChange() { return false; }

  /* ═══════════ 上下文 / 目录 动作分发 ═══════════ */
  function handleContext(act, id, el) {
    var s = curSession();
    switch (act) {
      case 'ctx-open': {
        if (!s || !s.team || !teamRole(s.team, ME)) { toast('这个会话不绑定团队上下文，没有自动材料'); return true; }
        state.ctxOpen = !state.ctxOpen;
        var wrap = $('.ctx-inline');
        if (wrap) {
          var btn = $('.c4-context', wrap), col = $('.ctx-collapse', wrap);
          if (btn) btn.setAttribute('aria-expanded', state.ctxOpen ? 'true' : 'false');
          if (col) { col.setAttribute('data-open', state.ctxOpen ? '1' : '0'); col.setAttribute('aria-hidden', state.ctxOpen ? 'false' : 'true'); }
        } else { renderStage(); }
        return true;
      }
      case 'ctx-detail': {
        if (s && s.team && teamRole(s.team, ME)) journeyDialog('本轮自动上下文明细', ctxBody(s), '', s.title);
        return true;
      }
      case 'ctx-memory': openMemory(state.memTab); return true;
      case 'mem-tab': openMemory(id === 'personal' ? 'personal' : 'team'); return true;
      case 'mem-remove': {
        var parts = String(id || '').split(':');
        MEM[parts[0]] = (MEM[parts[0]] || []).filter(function (m) { return m.id !== parts[1]; });
        openMemory(parts[0]);
        toast('已从本机 ' + parts[0] + '.md 移除该条记录');
        return true;
      }
      case 'mem-fix': {
        var pm = MEM.personal.filter(function (m) { return m.id === id; })[0];
        if (!pm) return true;
        pm.key = 'billing → ledger-service';
        pm.text = '本机把 order-service 里的 ../billing 指向 ~/work/harness/ledger-service（upstream pay/billing）。';
        pm.conflict = '';
        pm.src = 'personal.md · 刚刚 · 按系统地图更新';
        openMemory('personal');
        toast('已按系统地图更新本机 personal.md');
        return true;
      }
      case 'mem-propose': {
        pushProposal({
          kind: 'map', level: 'map', applies: 'order-service',
          title: '系统地图修订：order-service 的 ../billing 指向',
          source: '本机 personal.md 与已发布地图不一致，提议人认为本机映射才正确',
          diff: [ { t: 'ctx', x: 'order-service → ledger-service（共享契约）证据 ../billing/src/config.ts' },
                  { t: 'add', x: 'order-service → bill-export（共享契约）证据 ../billing/src/config.ts' } ]
        });
        openInbox(isAdmin(state.ws) ? 'todo' : 'sent', 'prop:' + state.proposals[0].id);
        toast('已发起地图修订提议，进入待审核队列');
        return true;
      }
      case 'mem-add': {
        var keyEl = $('#memKey'), textEl = $('#memText');
        var key = keyEl ? keyEl.value.trim() : '';
        var text = textEl ? textEl.value.trim() : '';
        if (!key) { showJourneyErr('请先填写记忆条目键名。', keyEl); return true; }
        MEM[state.memTab].push({ id: 'm-' + Date.now(), key: key, text: text || '（没有补充说明）', src: state.memTab + '.md · 刚刚' });
        openMemory(state.memTab);
        toast('已保存到本机 ' + state.memTab + '.md');
        return true;
      }
      case 'mem-collect': {
        var extra = MEM.personal.filter(function (m) { return !m.conflict && m.key.indexOf('→') > 0; });
        pushProposal({
          kind: 'map', level: 'map', applies: '全团队',
          title: '将本机新增关系整理为系统地图提议',
          source: '来源 personal.md 中 ' + extra.length + ' 条本机关系；不改动当前会话主目录',
          diff: extra.length ? extra.map(function (m) { return { t: 'add', x: m.key + ' — ' + m.text }; }) : [{ t: 'ctx', x: 'personal.md 里没有可整理的新增关系。' }]
        });
        openInbox(isAdmin(state.ws) ? 'todo' : 'sent', 'prop:' + state.proposals[0].id);
        toast('已把本机新增关系整理为系统地图提议');
        return true;
      }
      case 'dir-add': {
        if (!s || state.cross) return true;
        var input = $('#dirNewInput');
        var path = localPath(input ? input.value : '');
        if (!path) { showJourneyErr('目录要写成 ~/ 或 / 开头的本机路径。', input); return true; }
        if (path === s.mainDir || (s.extraDirs || []).indexOf(path) >= 0) { showJourneyErr('这个目录已经在当前会话里了。', input); return true; }
        s.extraDirs = (s.extraDirs || []).concat(path);
        syncRepos(s);
        render();
        openDirs();
        toast('已加入附加目录 · 自动上下文条已重算');
        return true;
      }
      case 'dir-suggest': {
        if (!s || state.cross || !id) return true;
        if (id === s.mainDir || (s.extraDirs || []).indexOf(id) >= 0) { toast('这个目录已经在会话里'); return true; }
        s.extraDirs = (s.extraDirs || []).concat(id);
        syncRepos(s);
        render();
        openDirs();
        toast('已加入 ' + baseName(id) + ' 作为附加目录');
        return true;
      }
      case 'dir-remove': {
        if (!s || state.cross) return true;
        s.extraDirs = (s.extraDirs || []).filter(function (p) { return p !== id; });
        syncRepos(s);
        render();
        openDirs();
        toast('已移除附加目录 · 自动上下文条已重算');
        return true;
      }
      case 'dir-pick-remove': {
        state.newDirs = (state.newDirs || []).filter(function (p) { return p !== id; });
        renderNewDirs();
        return true;
      }
      case 'ctx-use-multi': {
        if (!s) return true;
        changeAgent(s, 'multi');
        return true;
      }
      case 'ctx-common-parent': {
        if (!s) return true;
        var dirs = [s.mainDir].concat(s.extraDirs || []).filter(Boolean);
        var partsList = dirs.map(function (p) { return String(p).split('/'); });
        var common = [];
        for (var i = 0; i < partsList[0].length; i++) {
          var seg = partsList[0][i];
          if (partsList.every(function (q) { return q[i] === seg; })) common.push(seg); else break;
        }
        var parent = common.join('/');
        if (!parent || parent === s.mainDir) { toast('没有可用的共同上级目录'); return true; }
        s.mainDir = parent;
        s.extraDirs = [];
        syncRepos(s);
        render();
        openDirs();
        toast('主目录已改为共同上级 ' + parent);
        return true;
      }
      case 'ctx-newref': {
        if (!s) return true;
        var target = (s.extraDirs || [])[0] || s.mainDir;
        var ns = addSession('在 ' + baseName(target) + ' 继续：' + s.title, s.team, target, null, []);
        ns.msgs = [
          { w: 'reference', id: 'ref-' + Date.now(), from: ME, raw: s.mainDir, said: '由会话「' + s.title + '」带过来的引用',
            repo: repoPathToName(s.mainDir), local: target, state: 'linked',
            verify: '新会话主目录是目标仓库；原会话目录、草稿与消息都没有改动' },
          { w: 'sys', text: '从旧会话带了一条引用，旧会话仍保持自己的主目录。' }
        ];
        state.session = ns.id;
        state.cross = null;
        state.view = 'chat';
        state.shouldScrollEnd = true;
        syncSpaceFor(ns);
        closeDialog('dlgJourney');
        render();
        toast('已在 ' + baseName(target) + ' 新建会话并带上引用');
        return true;
      }
      case 'ref-link': case 'ref-relink': {
        var rm = findRef(id);
        if (!rm) return true;
        var suggest = rm.local || ('~/work/harness/' + (rm.repo || 'repo'));
        journeyDialog('关联本机目录', '<div class="c4-panel">' +
          '<p class="meta">原文：</p><span class="ref-raw">' + esc(rm.raw) + '</span>' +
          '<div class="fld"><label for="refDir">本机目录</label><input id="refDir" type="text" value="' + esc(suggest) + '">' +
          '<p class="help">只写入 personal.md，不改变当前会话主目录。</p></div></div>',
          journeyBtn('ref-link-ok', '保存关联', rm.id, true));
        return true;
      }
      case 'ref-link-ok': {
        var rl = findRef(id);
        var dirEl = $('#refDir');
        if (!rl || !dirEl) return true;
        var dir = localPath(dirEl.value);
        if (!dir) { showJourneyErr('目录要写成 ~/ 或 / 开头的本机路径。', dirEl); return true; }
        var file = baseName(rl.raw) || '';
        rl.local = dir.replace(/\/+$/, '') + (file && dir.indexOf('/' + file) < 0 ? '/' + file : '');
        rl.state = 'linked';
        rl.verify = 'personal.md 已记录映射 · 当前会话主目录仍是 ' + (curSession() ? curSession().mainDir : '不变');
        MEM.personal.push({ id: 'pm-' + Date.now(), key: (rl.repo || '引用') + ' → ' + baseName(dir),
          text: '本机把 ' + rl.raw + ' 映射到 ' + rl.local + '。', src: 'personal.md · 刚刚' });
        closeDialog('dlgJourney');
        render();
        toast('已关联本机目录并写入 personal.md');
        return true;
      }
      case 'ref-open': {
        var ro = findRef(id);
        toast(ro && ro.local ? '在本机编辑器中打开：' + ro.local : '这条引用还没有本机路径');
        return true;
      }
      case 'ref-remove': {
        var removed = false;
        state.sessions.forEach(function (x) {
          x.msgs = (x.msgs || []).filter(function (m) {
            if (m.w === 'reference' && m.id === id) { removed = true; return false; }
            return true;
          });
        });
        render();
        toast(removed ? '已移除该条引用记录' : '这条记录已经不存在');
        return true;
      }
      default: return false;
    }
  }

  /* ═══════════ 总渲染 ═══════════ */
  function render() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.accent = state.accent;
    document.documentElement.dataset.density = state.density;
    document.documentElement.style.setProperty('--ui-zoom', state.zoom);
    $('#app').classList.toggle('no-side', !state.side);
    renderSidebar();
    renderTopbar();
    renderStage();
    renderRail();
    if (!$('#popover').hidden) renderPopover();
    if (!$('#palette').hidden) {
      var pl = $('#palList');
      if (pl) put(pl, paletteListHtml());
    }
    var sd = document.getElementById('dlgSettings');
    if (sd && sd.open) renderSettings();
    applyFocus();
  }

  function journeyBtn(act, label, id, primary, attrs) {
    return '<button type="button" class="btn btn-sm ' + (primary ? 'btn-primary' : 'btn-secondary') + '" data-act="' + esc(act) + '"' +
      (id ? ' data-id="' + esc(id) + '"' : '') + (attrs ? ' ' + attrs : '') + '>' + esc(label) + '</button>';
  }
  function journeyDialog(title, body, actions, subtitle) {
    var dialog = $('#dlgJourney');
    put(dialog, '<div class="dlg"><div class="dlg-head"><div class="od-stack" style="--od-gap:2px"><h2 id="journeyTitle">' + esc(title) + '</h2>' +
      (subtitle ? '<p class="dlg-sub">' + esc(subtitle) + '</p>' : '') + '</div>' +
      '<button type="button" class="icon-btn" style="margin-left:auto" data-act="dlg-close" data-dlg="dlgJourney" aria-label="关闭">' + icon('x', 15) + '</button></div>' +
      '<div class="dlg-body c4-panel">' + body + '<p class="err" id="journeyErr" hidden role="alert"></p></div><div class="dlg-foot"><span class="spacer"></span>' +
      journeyBtn('dlg-close', actions ? '取消' : '完成', '', false, 'data-dlg="dlgJourney"') + (actions || '') + '</div></div>');
    if (!dialog.open) openDialog('dlgJourney');
    else (dialog.querySelector('[data-initial], .dlg-body input, .dlg-body select, .dlg-body textarea, .dlg-body button') || dialog.querySelector('button')).focus();
  }
  function showJourneyErr(msg, focusEl) {
    var err = $('#journeyErr');
    if (err) { err.textContent = msg; err.hidden = false; }
    else toast(msg);
    if (focusEl && focusEl.focus) focusEl.focus();
  }
  function localPath(value) {
    var path = String(value || '').trim().replace(/\/{2,}/g, '/').replace(/\/$/, '');
    return /^(~\/|\/)[^\u0000-\u001f\\]+$/.test(path) && !path.split('/').some(function (part) { return part === '..' || part === '.'; }) ? path : '';
  }
  function addSession(title, team, dir, share, extra, owner) {
    var s = { id: 's-' + Date.now() + '-' + state.sessions.length, owner: owner || ME, title: title, team: team,
      mainDir: dir, extraDirs: extra || [], repos: [], agent: 'multi', shareProject: share || null, originProject: share || null,
      files: [], msgs: [], time: '刚刚', running: false, unread: false };
    state.sessions.unshift(s);
    syncRepos(s);
    return s;
  }
  function visibility(s) {
    var p = projById(s.shareProject);
    return p ? 'Project 可见 · ' + p.name : '仅本人';
  }
  function sessionMeta(s) {
    var team = esc(wsById(s.team).name), scope = esc(visibility(s));
    var locked = (s.msgs || []).some(function (m) { return m.w === s.owner; });
    var settle = state.handshake && state.handshake.id === s.id && (Date.now() - state.handshake.at < 700);
    var teamChip = locked
      ? '<span class="c4-chip od-truncate" title="团队上下文：' + team + '（发出首条消息后已绑定）">' + icon('lock', 10) + ' ' + team + '</span>'
      : '<button type="button" class="c4-chip od-truncate" style="border:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px" data-act="team-menu" aria-haspopup="menu" aria-expanded="false" title="首条消息发送前可切换团队上下文">团队：' + team + icon('chev', 10) + '</button>';
    return '<span class="c4-meta">' + teamChip +
      '<span class="c4-chip od-truncate ' + (s.shareProject ? 'shared' : '') + (settle ? ' is-settling' : '') + '" title="可见性：' + scope + '">' + scope + '</span></span>';
  }
  function publishTargets(s) {
    return state.projects.filter(function (p) {
      return projectAccess(p) && (!s || !s.team || p.ws === s.team);
    });
  }
  function projectBriefs(project) {
    var rows = peersOf(project.id).filter(function (p) { return !p.archived; });
    var mine = mySessions().filter(function (s) { return s.shareProject === project.id; });
    return '<section class="c4-briefs c4-panel"><h3>Project 会话简报</h3><p class="meta">只显示已发布会话。队友正文需主动同步。</p>' +
      (mine.concat(rows).length ? mine.map(function (s) {
        return '<div class="c4-row">' + av(ME, 24) + '<div class="od-fill od-stack"><span>' + esc(s.title) + '</span><span class="meta">我的发布 · 本机可执行</span></div>' + journeyBtn('session', '打开会话', s.id) + '</div>';
      }).join('') + rows.map(function (p) {
        return '<div class="c4-row">' + av(p.owner, 24) + '<div class="od-fill od-stack"><span>' + esc(p.title) + '</span><span class="meta">' + esc(PEOPLE[p.owner].name) + ' · ' + esc(p.brief) + '</span></div>' +
          journeyBtn('pop-open', '查看简报', p.id, false, 'data-owner="' + esc(p.owner) + '"') + '</div>';
      }).join('') : '<p class="meta">暂无已发布会话，可以从上方新建 Project 会话。</p>') + '</section>';
  }
  function perspectiveChoices() {
    return '<div class="c4-bar" role="group" aria-label="演示视角切换">' + [[ADMIN, '管理员（张景新）'], [DEV, '开发者（沈北辰）'], [SOLO, '未加入团队']].map(function (entry) {
      return journeyBtn('perspective-set', entry[1], entry[0], entry[0] === ME, 'aria-pressed="' + (entry[0] === ME) + '" data-focus="c4-perspective-' + entry[0] + '"');
    }).join('') + '</div>';
  }
  function switchPerspective(person) {
    if (![ADMIN, DEV, SOLO].includes(person)) return;
    if ($('#dlgJourney').open) closeDialog('dlgJourney');
    closeMenu(); closePopover(); closePalette(); closeMobileDrawer();
    ME = person;
    var ws = WORKSPACES.find(function (w) { return teamRole(w.id, ME); });
    state.ws = ws ? ws.id : null;
    state.proj = (wsProjects()[0] || {}).id || null;
    state.session = (privateSessions()[0] || mySessions()[0] || {}).id || null;
    state.space = 'personal'; state.sidePane = 'sessions'; state.boardProj = 'all'; state.taskSel = null; state.inboxSel = null;
    state.cross = null; state.preview = null; state.pvMax = false;
    state.view = 'chat'; state.kscope = 'all'; state.kSel = null; state.atq = null;
    state.projEdit = false; state.shouldScrollEnd = true;
    state.focusKey = $('#dlgSettings').open ? 'c4-perspective-' + person : null;
    render();
    toast('已切换到' + (person === SOLO ? '未加入团队视角' : PEOPLE[person].name + ' · ' + (teamRole(state.ws, ME) || '未加入团队')));
  }
  function roleBody(ws) {
    if (!ws.id) return '<p class="meta">当前账号未加入任何团队，本机 Agent 照常可用。</p>';
    var editable = isAdmin(ws.id);
    return '<div class="c4-panel"><p class="meta">' + esc(ws.name) + ' · Workspace 角色与 Project 角色独立' +
      (editable ? '' : ' · 当前为只读') + '</p>' + ws.members.map(function (m) {
        var role = teamRole(ws.id, m);
        return '<div class="c4-row">' + av(m, 26) + '<span class="od-fill od-stack"><span>' + esc(PEOPLE[m].name) + '</span><span class="meta">' + esc(role + (m === ME ? ' · 当前账号' : '')) + '</span></span>' +
          (editable ? journeyBtn('role-change', role === '管理员' ? '设为开发者' : '设为管理员', m) + journeyBtn('role-remove', '移除成员', m) : '') + '</div>';
      }).join('') + '<p class="set-section-title">团队已登记仓库</p><div class="c4-bar">' + repoNames(ws.id).map(function (repo) {
        return '<span class="c4-chip c4-path">' + esc(repo) + '</span>';
      }).join('') + '</div></div>';
  }
  function openRoles() { closeMenu(); journeyDialog('成员与角色管理', roleBody(curWs())); }
  function lastAdmin(ws, person) {
    return teamRole(ws.id, person) === '管理员' && ws.members.filter(function (m) { return teamRole(ws.id, m) === '管理员'; }).length === 1;
  }
  function roleChange(person, remove, confirmed) {
    var ws = curWs();
    if (!isAdmin(ws.id) || !teamRole(ws.id, person)) return;
    if (lastAdmin(ws, person)) {
      journeyDialog('无法更改 Workspace 成员', '<p>最后一名管理员不能被降级或移除</p><p class="meta">请先将另一名成员设为管理员。</p>', journeyBtn('roles', '返回成员列表'));
      toast('最后一名管理员不能被降级或移除');
      return;
    }
    if (remove && !confirmed) {
      journeyDialog('移除 Workspace 成员', '<p>将 ' + esc(PEOPLE[person].name) + ' 移出当前 Workspace？移除后不再能访问该团队及所属 Project。</p>', journeyBtn('role-remove-ok', '确认移除', person, true));
      return;
    }
    if (remove) {
      ws.members = ws.members.filter(function (member) { return member !== person; });
      delete ws.roles[person];
      if (person === ME) { switchPerspective(person); return; }
    } else ws.roles[person] = teamRole(ws.id, person) === '管理员' ? '开发者' : '管理员';
    render(); openRoles();
    toast(remove ? '已移除 ' + PEOPLE[person].name : PEOPLE[person].name + ' 已设为' + ws.roles[person]);
  }
  function handleJourney(act, id, el) {
    var s = curSession();
    switch (act) {
      case 'perspective': journeyDialog('演示视角切换', perspectiveChoices()); break;
      case 'perspective-set': switchPerspective(id); break;
      case 'roles': openRoles(); break;
      case 'role-change': roleChange(id, false, true); break;
      case 'role-remove': roleChange(id, true, false); break;
      case 'role-remove-ok': roleChange(id, true, true); break;
      case 'share-open': {
        var targets = publishTargets(s);
        if (!s || state.cross || s.shareProject || !targets.length) break;
        journeyDialog('发布到 Project', '<p>发布后 Project 成员可见简报并可主动同步定稿正文；已被他人同步的内容无法收回。</p>' +
          (!s.team ? '<div class="k-warn"><span>当前会话尚未绑定团队；发布后会同步绑定目标 Project 所在的 Workspace 上下文。</span></div>' : '<p class="meta">只共享定稿对话，不上传草稿、自动材料和本机记忆；不改变团队上下文。</p>') +
          '<div class="fld"><label for="shareTarget">目标 Project' + (s.team ? '（限当前团队 ' + esc(wsById(s.team).name) + '）' : '') + '</label><select id="shareTarget">' + targets.map(function (p) {
            return '<option value="' + esc(p.id) + '"' + (p.id === state.proj ? ' selected' : '') + '>' + esc(p.name + ' · ' + wsById(p.ws).name) + '</option>';
          }).join('') + '</select></div><label class="c4-check"><input type="checkbox" id="shareRange"> 我确认向目标 Project 成员共享定稿对话</label>', journeyBtn('share-confirm', '确认发布', s.id, true), s.title);
        break;
      }
      case 'share-confirm': {
        var target = $('#shareTarget'), range = $('#shareRange');
        if (!s || s.id !== id || state.cross || s.shareProject || !target || !range) break;
        if (!range.checked) { showJourneyErr('请先勾选确认共享范围', range); break; }
        var selected = projById(target.value);
        if (!projectAccess(selected) || (s.team && selected.ws !== s.team)) { toast('只能发布到当前团队所属 Project'); break; }
        if (!s.team) s.team = selected.ws;
        s.shareProject = selected.id;
        state.view = 'chat'; state.cross = null; state.handshake = { id: s.id, dir: 'to-team', at: Date.now() };
        syncSpaceFor(s);
        closeDialog('dlgJourney'); render(); toast('已发布到 ' + selected.name + ' · 已切到团队空间并停留在本会话'); break;
      }
      case 'share-stop':
        if (s && s.shareProject && !state.cross) journeyDialog('停止共享', '<p>停止共享后不再上传新内容，已被他人同步的内容无法收回。</p><p class="meta">此会话仍保存在本机，团队上下文不变。</p>', journeyBtn('share-stop-ok', '确认停止共享', s.id, true), s.title);
        break;
      case 'share-stop-ok':
        if (s && s.id === id && !state.cross && s.shareProject) {
          s.shareProject = null; state.view = 'chat'; state.cross = null; state.handshake = { id: s.id, dir: 'to-personal', at: Date.now() };
          syncSpaceFor(s); closeDialog('dlgJourney'); render(); toast('已停止共享 · 已切回个人空间并停留在本会话');
        }
        break;
      default: return handleContext(act, id, el) || handleKnowledge(act, id, el);
    }
    return true;
  }
  function initJourney() {
    WORKSPACES.forEach(function (ws) { ws.roles = { zhangjingxin: '管理员' }; });
    state.projects.forEach(function (p) { p.lead = p.members[0]; });
    state.sessions.forEach(function (s) {
      var p = projById(s.proj);
      Object.assign(s, { owner: ADMIN, team: p.ws, shareProject: s.id === 's1' ? p.id : null, originProject: p.id,
        mainDir: s.dir, extraDirs: s.id === 's1' ? ['~/work/harness/order-service'] : [], agent: 'multi' });
      delete s.local; delete s.dir; delete s.proj;
      syncRepos(s);
    });
    /* 给私有会话 s2 挂一个待批准的本机命令审批，验证“本机审批留在会话行，不进团队 Inbox” */
    var s2 = state.sessions.filter(function (x) { return x.id === 's2'; })[0];
    if (s2) {
      s2.msgs.push({
        w: 'approval', id: 'a-s2', kind: '命令执行审批',
        code: 'npx vitest run config/gray-release.test.ts',
        reason: '将在本机执行灰度配置单元测试；不会联网或上传。'
      });
    }
    state.peers.filter(function (p) { return p.owner === DEV; }).forEach(function (p) {
      var proj = projById(p.proj);
      var s = addSession(p.title, proj.ws, '~/work/harness/' + baseName(proj.repo), p.proj, [], p.owner);
      Object.assign(s, { msgs: p.msgs.slice(), time: p.time, peerId: p.id, shareBrief: p.brief });
      p.sessionId = s.id;
    });
    var defaultPersonalId = null;
    [ADMIN, DEV, SOLO].forEach(function (owner) {
      var s = addSession('本地日志分析脚本调试', null, '~/Documents/log-lab', null, [], owner);
      s.msgs = [{ w: owner, text: '只分析本地脱敏日志，先区分超时和主动断开。' }, { w: 'agent', text: '已按 requestId 聚合事件。这个无团队会话不装配团队知识或本机记忆。' }];
      s.files = [{ n: 'scripts/summarize-log.py', t: '刚刚' }, { n: 'samples/sanitized.log', t: '今天' }];
      if (owner !== SOLO) {
        var draft = addSession('退款查询接口草稿验证', 'ws-base', '~/work/harness/order-service', null, ['~/work/harness/common-proto'], owner);
        draft.time = '刚刚';
        draft.files = [
          { n: 'src/refund/query.ts', t: '刚刚', st: 'M' },
          { n: 'proto/refund.proto', t: '10 分钟前', st: 'A' }
        ];
        draft.msgs = [
          { w: 'sys-divider', label: '今天 10:28 · 个人草稿 · 本机 ~/work/harness/order-service (+1 附加目录)' },
          { w: owner, time: '10:28', text: '先验证退款查询接口的返回语义，注意错误码与幂等规则，这是未发布的个人草稿。' },
          { w: 'workgroup', title: '已读取团队知识与本机记忆（3 步）', dur: '1.1s',
            summary: '读取固定版本规约并查询本机 team.md 映射关系',
            rows: [
              { ic: 'book', verb: 'read_team_knowledge', target: 'knowledge:k2:v2.1', badge: '固定版本', tone: 'ok', knowledge: 'k2', version: 'v2.1',
                out: '1. Key 格式：pay:{idem}:<bizType>:<orderId>:<subNo>\n2. 有效期：查询类链路 2h，退款写入链路 24h' },
              { ic: 'search', verb: 'query_project_memory', target: 'team.md', badge: '命中 2 条', tone: 'ok',
                out: 'order-service -> common-proto [系统地图 v1.2]\nbilling === ledger-service [team.md]' },
              { ic: 'pen', verb: 'propose_project_memory_update', target: 'team.md', badge: 'pending -> 已写入', tone: 'ok',
                out: '+ order-service 退款查询接口统一返回整数分 settleCents' }
            ] },
          { w: 'agent', model: 'claude-sonnet-4', time: '10:29', blocks: [
            { t: 'p', text: '已结合《分布式幂等键设计规范》v2.1 与《金额字段整数分编码规约》v1.4 核对完成：建议把未找到、处理中、已终态明确区分，金额一律按 int64 分透传。' }
          ] },
          { w: 'sys', text: '项目记忆已更新 · 本轮只在本机保存，团队成员不可见；需要协作时可点击顶部「发布到 Project…」' }
        ];
        if (owner === ADMIN) defaultPersonalId = draft.id;
      }
    });
    initContext();
    initKnowledge();
    state.session = defaultPersonalId || (privateSessions()[0] || {}).id || 's1';
  }
  if (window.matchMedia) {
    var narrowMq = window.matchMedia('(max-width: 1040px)');
    var syncNarrow = function (ev) {
      if (ev.matches && state.rail) { state.rail = false; render(); }
    };
    if (narrowMq.addEventListener) narrowMq.addEventListener('change', syncNarrow);
  }
  initJourney();
  render();
  requestAnimationFrame(function () { animateSegs(document); });
})();
