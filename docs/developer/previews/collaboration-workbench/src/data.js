/* ═══ 原型示例数据：覆盖 HC-233 / HC-239～HC-254 与 Playbook/SOP 扩展 ═══ */
export const AV_BASE = 'assets/avatars/';
export const ADMIN = 'zhangjingxin';
export const DEV = 'shenbeichen';
export const SOLO = 'solo';

export const PEOPLE = {
  zhangjingxin: { name: '张景新', role: '后端开发 · 管理员', lead: true, avatar: 'zhangjingxin.jpg' },
  shenbeichen:  { name: '沈北辰', role: '前端开发', lead: false, avatar: 'shenbeichen.jpg' },
  wangdalin:    { name: '王大林', role: '后端开发', lead: false, avatar: 'wangdalin.jpg' },
  mingfangpeng: { name: '明方鹏', role: '后端开发', lead: false, avatar: 'mingfangpeng.jpg' },
  yangkang:     { name: '杨康',   role: '后端开发', lead: false, avatar: 'yangkang.jpg' },
  fengxueming:  { name: '冯学茗', role: '前端开发', lead: false, avatar: 'fengxueming.jpg' },
  solo:         { name: '本机账号', role: '未加入团队', lead: false }
};

export const WORKSPACES = [
  {
    id: 'ws-base',
    name: '支付核心研发组',
    desc: '交易、结算与拆单支付核心服务',
    members: ['zhangjingxin', 'shenbeichen', 'wangdalin', 'mingfangpeng', 'yangkang', 'fengxueming'],
    roles: { zhangjingxin: '管理员', shenbeichen: '开发者', wangdalin: '开发者', mingfangpeng: '开发者', yangkang: '开发者', fengxueming: '开发者' }
  },
  {
    id: 'ws-risk',
    name: '风控联调专项组',
    desc: '大促风控规则与网关鉴权联调',
    members: ['zhangjingxin', 'shenbeichen'],
    roles: { zhangjingxin: '管理员', shenbeichen: '管理员' }
  }
];

export const WS_REPOS = {
  'ws-base': ['pay/checkout-split', 'pay/bill-export', 'pay/idem-gateway', 'pay/common-proto'],
  'ws-risk': ['risk/rule-engine', 'pay/checkout-split']
};

export const INITIAL_PROJECTS = [
  {
    id: 'p-checkout', ws: 'ws-base', name: '结账台拆分支付重构',
    desc: '拆单支付核心链路改造，涵盖状态机流转、幂等退款与灰度开关控制。',
    repo: 'pay/checkout-split', created: '2025-09-18', lead: 'zhangjingxin',
    members: ['zhangjingxin', 'shenbeichen', 'wangdalin', 'mingfangpeng', 'yangkang', 'fengxueming']
  },
  {
    id: 'p-bill', ws: 'ws-base', name: '对账单异步导出优化',
    desc: '优化大账单异步分片流式导出与游标断点续传，统一金额整数分规约。',
    repo: 'pay/bill-export', created: '2025-10-27', lead: 'zhangjingxin',
    members: ['zhangjingxin', 'shenbeichen', 'wangdalin']
  },
  {
    id: 'p-risk', ws: 'ws-risk', name: '大促风控灰度放量',
    desc: '联调风控实时决策接口与兜底降级阈值。',
    repo: 'risk/rule-engine', created: '2026-11-08', lead: 'zhangjingxin',
    members: ['zhangjingxin', 'shenbeichen']
  }
];

export const INITIAL_SESSIONS = [
  {
    id: 's-home-1', owner: 'zhangjingxin', team: 'ws-base', shareProject: 'p-checkout', shareMode: 'full',
    title: '支付状态机回调时序核对', time: '2 分钟前', mainDir: '~/work/pay/checkout-split',
    extraDirs: ['~/work/pay/common-proto'], running: true, unread: false, agent: 'acp-multi',
    files: [
      { n: 'src/state/refund.ts', st: 'M', t: '刚刚', add: 18, del: 4 },
      { n: 'src/state/refund.test.ts', st: 'A', t: '3m', add: 42, del: 0 },
      { n: 'docs/refund-sequence.md', st: 'A', t: '5m', add: 26, del: 0 }
    ],
    artifacts: [
      {
        id: 'art-1', kind: 'mermaid', name: 'docs/refund-sequence.md', title: '退款回调与补偿幂等时序',
        body: `# 退款回调与补偿幂等时序\n\n- 状态迁移只允许 \`PAID -> REFUNDING / PARTIAL_REFUNDED\`\n- 回调入口 \`callback/refund.ts\` 与定时补偿 \`job/compensate.ts\` 共用 \`idempotent(orderId, refundNo)\` 闸门\n- **已验证测试**：3 个并发回调重复投递单测全部通过`,
        mermaid: `sequenceDiagram\n  渠道->>callback/refund.ts: 回调通知(orderId, refundNo)\n  callback/refund.ts->>idem-gateway: acquire(orderId+refundNo)\n  alt 首次处理\n    idem-gateway-->>callback/refund.ts: OK\n    callback/refund.ts->>DB: PAID -> REFUNDED\n  else 重复投递\n    idem-gateway-->>callback/refund.ts: 409/幂等返回\n  end`
      }
    ],
    msgs: [
      { w: 'zhangjingxin', time: '10:12', text: '核对 `src/state/refund.ts` 与 `common-proto` 的错误码约定，确认重复回调会不会双倍记账。', ctx: [{ t: '规约：接口错误码与金额整数分', know: '接口错误码与金额整数分规约', ver: 'v2.1' }] },
      { w: 'thinking', label: '检索团队知识并检查状态机入口', dur: '1.8s', body: ['自动带入规约《接口错误码与金额整数分规约》，并调用 read_team_knowledge 读取《回调幂等经验 v1.3》。'] },
      {
        w: 'workgroup', title: '已读取团队知识与跨仓代码', dur: '3.2s',
        summary: '检查了 2 个仓库共 3 个文件，确认 job/compensate.ts 缺少幂等闸门。',
        rows: [
          { ic: 'book', verb: 'read_team_knowledge', target: '回调幂等经验 · v1.3', badge: '已读固定版本', tone: 'ok', knowledge: 'k-idem', version: 'v1.3', out: '【关键结论】回调与补偿任务必须共用 idempotent(orderId, refundNo)。' },
          { ic: 'eye', verb: '读取文件', target: 'src/state/refund.ts', file: 'src/state/refund.ts', badge: '142 行' },
          { ic: 'terminal', verb: '运行单测', target: 'npm test -- refund.test.ts', badge: '3 passed', tone: 'ok', out: '✓ 并发重复回调返回首次成功载荷\n✓ 补偿任务跳过已退款状态\n✓ 金额整数分校验通过' }
        ]
      },
      {
        w: 'approval', id: 'ap-push-1', kind: '外部系统写入 · Git Push', state: 'pending',
        code: 'git push origin feat/refund-idem-gate',
        reason: '本机文件修改已在工作区自动执行；推送到远端共享仓库属于外部副作用，需由你明确批准一次。'
      },
      {
        w: 'agent', time: '10:15', model: 'Claude Sonnet 4.5 (企业网关)',
        blocks: [
          { t: 'p', text: '已核对完成：此前 `job/compensate.ts` 确实绕过了 `idempotent(orderId, refundNo)` 闸门，已在 `src/state/refund.ts` 收口并通过 3 项回归测试。' },
          { t: 'ul', items: ['遵循 @《回调幂等经验》v1.3 补充并发重入校验', '已生成 `docs/refund-sequence.md` 产物供右侧预览', '待你批准后即可推送分支'] }
        ],
        files: [
          { n: 'src/state/refund.ts', add: 18, del: 4 },
          { n: 'src/state/refund.test.ts', add: 42, del: 0 }
        ]
      }
    ]
  },
  {
    id: 's-priv-1', owner: 'zhangjingxin', team: 'ws-base', shareProject: null,
    title: '本地拆单表索引基准测试', time: '今天 09:30', mainDir: '~/work/pay/checkout-split',
    extraDirs: [], running: false, unread: true, agent: 'acp-multi',
    files: [{ n: 'scripts/bench-order-idx.sql', st: 'A', t: '09:32', add: 34, del: 0 }],
    artifacts: [],
    msgs: [
      { w: 'zhangjingxin', time: '09:30', text: '我在本机做一下拆单表复合索引的压测脚本，这个个人会话先不公开到 Project。' },
      {
        w: 'diag', stage: 'provider', code: 'GATEWAY_QUOTA_WARN',
        title: '企业模型网关提示（示例诊断卡 · HC-244 / HC-254）',
        message: '上次调用 Codex 通道时响应超时（408），已自动切换备用通道完成。',
        suggestion: '可在「管理模式 → 企业模型网关」查看通道健康度，或一键复制脱敏诊断 JSON 发给运维。',
        detail: { phase: 'provider', model: 'gpt-5-codex', latencyMs: 12400, fallback: 'claude-sonnet-4.5', masked: true }
      },
      {
        w: 'agent', time: '09:32', model: 'Claude Sonnet 4.5',
        blocks: [
          { t: 'p', text: '已在本机生成 `scripts/bench-order-idx.sql`（联合索引 `(merchant_id, created_at, status)`）。本会话仅存本机，不上传云端、不进入组织审计。' }
        ]
      }
    ]
  },
  {
    id: 's-priv-2', owner: 'zhangjingxin', team: null, shareProject: null,
    title: '个人 Markdown 命令行小工具', time: '昨天', mainDir: '~/playground/md-clip',
    extraDirs: [], running: false, unread: false, agent: 'acp-single',
    files: [{ n: 'src/cli.ts', st: 'M', t: '昨天', add: 12, del: 2 }],
    artifacts: [],
    msgs: [
      { w: 'zhangjingxin', time: '昨天 20:10', text: '帮我写一个无团队上下文的本地脚本，把剪贴板 HTML 转成干净 Markdown。' },
      { w: 'agent', time: '昨天 20:11', model: 'Local / DeepSeek', blocks: [{ t: 'p', text: '已完成 `src/cli.ts`。当前会话未绑定团队，未注入任何团队知识或组织记忆。' }] }
    ]
  },
  {
    id: 's-priv-bill', owner: 'zhangjingxin', team: 'ws-base', shareProject: null,
    title: '游标分片导出内存占用排查', time: '2 天前', mainDir: '~/work/pay/bill-export',
    extraDirs: [], running: false, unread: false, agent: 'acp-multi',
    files: [{ n: 'src/export/cursor.ts', st: 'M', t: '2天前', add: 9, del: 5 }],
    artifacts: [],
    msgs: [
      { w: 'zhangjingxin', time: '前天 16:00', text: '排查大账单导出 OOM 的原因。' },
      { w: 'agent', time: '前天 16:02', model: 'Claude Sonnet 4.5', blocks: [{ t: 'p', text: '定位到流式缓冲未设置 highWaterMark，已修复并记录在本机 `team.md`。' }] }
    ]
  },
  {
    id: 's-dev-1', owner: 'shenbeichen', team: 'ws-base', shareProject: 'p-checkout', shareMode: 'full',
    title: '收银台拆分支付弹窗联调', time: '15 分钟前', mainDir: '~/code/checkout-split',
    extraDirs: [], running: false, unread: false, agent: 'acp-multi',
    files: [{ n: 'src/ui/SplitPayModal.tsx', st: 'M', t: '15m', add: 28, del: 6 }],
    artifacts: [],
    msgs: [
      { w: 'shenbeichen', time: '10:00', text: '按照规约补齐拆单支付弹窗的整数分金额展示。' },
      { w: 'agent', time: '10:02', model: 'Claude Sonnet 4.5', blocks: [{ t: 'p', text: '已更新 `SplitPayModal.tsx`，所有金额统一按分运算并在展示层格式化。' }] }
    ]
  },
  {
    id: 's-solo-1', owner: 'solo', team: null, shareProject: null,
    title: '本机自由探索 · SQLite 索引测试', time: '刚刚', mainDir: '~/workspace/local-demo',
    extraDirs: [], running: false, unread: false, agent: 'acp-multi',
    files: [{ n: 'bench.ts', st: 'A', t: '刚刚', add: 20, del: 0 }],
    artifacts: [],
    msgs: [
      { w: 'solo', time: '10:20', text: '未加入团队时也可以直接使用本机 Agent 吗？' },
      { w: 'agent', time: '10:20', model: 'Local / Default', blocks: [{ t: 'p', text: '可以！执行权跟着「人 + 本机」走，无需团队或云端 Project 即可开启本机会话。' }] }
    ]
  }
];

export const INITIAL_PEERS = [
  {
    id: 'peer-sbc-1', owner: 'shenbeichen', proj: 'p-checkout', title: '收银台拆分支付表单校验',
    time: '8 分钟前', sync: 'updated', archived: false,
    brief: '已完成拆单支付前端金额校验与错误码映射，待后端确认 `409 PROCESSING` 返回结构。',
    points: ['`SplitPayModal.tsx` 增加分期金额整数分校验', '复用 @《接口错误码与金额整数分规约》v2.1', '已附未提交本地预览截图说明'],
    notes: [{ who: 'wangdalin', time: '5 分钟前', text: '409 响应会带上 `retryAfterMs` 字段，前端可以做倒计时禁用重试。' }],
    msgs: [
      { w: 'shenbeichen', time: '10:05', text: '把拆单支付的表单校验和错误码映射做完，方便后端联调。' },
      { w: 'agent', time: '10:07', model: 'Claude Sonnet 4.5', blocks: [{ t: 'p', text: '已修改 `src/ui/SplitPayModal.tsx` 并补充 4 个组件单测；等待后端确认 409 载荷字段。' }] }
    ]
  },
  {
    id: 'peer-wdl-1', owner: 'wangdalin', proj: 'p-checkout', title: 'common-proto 退款枚举字段补充',
    time: '35 分钟前', sync: 'synced', archived: false,
    brief: '在 `common-proto` 新增 `PARTIAL_REFUNDED` 状态与错误码枚举，等待联调测试。',
    points: ['新增 `RefundStatus.PARTIAL_REFUNDED = 4`', '已通过 proto lint 检查'],
    notes: [],
    msgs: [
      { w: 'wangdalin', time: '09:30', text: '更新 `common-proto/pay/refund.proto` 枚举。' },
      { w: 'agent', time: '09:31', model: 'Codex', blocks: [{ t: 'p', text: '已完成枚举补充并生成 TS/Go stub。' }] }
    ]
  }
];

export const INITIAL_TASKS = [
  {
    id: 't1', proj: 'p-checkout', title: '补齐拆单支付 409 retryAfterMs 字段',
    desc: '按前端联调反馈，在 `refund/status` 接口中补充 `retryAfterMs`，并附带单测与交付物说明。',
    from: 'shenbeichen', to: 'zhangjingxin', status: 'open', prio: 'high', time: '10 分钟前',
    src: 'session', srcTitle: '收银台拆分支付表单校验', deliverable: '等待接手并提交交付说明'
  },
  {
    id: 't2', proj: 'p-checkout', title: '验证 job/compensate.ts 幂等闸门回归',
    desc: '在本地 `checkout-split` 仓库跑通并发回调 + 补偿任务压测并提交报告卡片。',
    from: 'zhangjingxin', to: 'wangdalin', status: 'running', prio: 'high', time: '1 小时前',
    src: 'board', live: true, deliverable: '正在本机执行压测脚本'
  },
  {
    id: 't3', proj: 'p-bill', title: '对账单游标分片内存上限压测',
    desc: '导出 100 万行账单观察堆内存峰值是否控制在 128MB 以内。',
    from: 'zhangjingxin', to: 'zhangjingxin', status: 'claimed', prio: 'mid', time: '昨天',
    src: 'board', stale: '已停滞 1 天', deliverable: '已接受，待选择本机目录开始'
  },
  {
    id: 't4', proj: 'p-checkout', title: '前端金额展示统一走 formatCents()',
    desc: '清理遗留浮点数元转分逻辑，全部改用公共整数分格式化函数。',
    from: 'zhangjingxin', to: 'shenbeichen', status: 'done', prio: 'mid', time: '2 天前',
    src: 'board', deliverable: '已验收通过 · PR #418 已合入'
  }
];

export const INITIAL_KNOWLEDGE = [
  {
    id: 'k-rule-1', ws: 'ws-base', level: 'rule', applies: '全团队', version: 'v2.1', updated: '昨天', author: 'zhangjingxin',
    title: '接口错误码与金额整数分规约',
    sum: '所有支付/退款金额在内存、数据库和跨服务契约中一律以整数「分」存储与传输，禁止使用浮点数。',
    body: '1. 金额字段命名统一为 `*Cents`（int64），严禁出现 float/double 金额计算。\n2. 并发幂等冲突统一返回 HTTP 409 + `code: PROCESSING` 与 `retryAfterMs`。\n3. 跨服务错误码必须先登记在 `common-proto/errors.proto`。',
    hits: 42, useful: 18, staleCount: 0,
    traces: [
      { who: 'zhangjingxin', session: '支付状态机回调时序核对', time: '10:12', note: '规约级范围匹配（全团队），本轮自动直带正文' },
      { who: 'shenbeichen', session: '收银台拆分支付弹窗联调', time: '10:00', note: '规约级自动直带，校验 formatCents()' }
    ],
    hist: [{ who: 'zhangjingxin', act: '审核发布', ver: 'v2.1', date: '2026-11-23' }]
  },
  {
    id: 'k-idem', ws: 'ws-base', level: 'exp', applies: 'pay/checkout-split', version: 'v1.3', updated: '3 天前', author: 'wangdalin',
    title: '回调幂等经验',
    sum: '退款渠道回调与定时补偿任务必须共用同一把幂等键 `orderId + refundNo`，禁止跳过闸门直接改库。',
    body: '【踩坑背景】10 月大促期间，渠道重复回调与补偿脚本并发执行导致同一退款单记账两次。\n【解决方式】统一收敛到 `idempotent(orderId, refundNo)`，重入时直接返回首次成功载荷。',
    hits: 29, useful: 12, staleCount: 1,
    traces: [
      { who: 'zhangjingxin', session: '支付状态机回调时序核对', time: '10:13', note: 'Agent 调用 read_team_knowledge 命中「解决方式」段落' }
    ],
    hist: [{ who: 'wangdalin', act: '提议新增', ver: 'v1.0', date: '2026-10-15' }, { who: 'zhangjingxin', act: '跨人融合发布', ver: 'v1.3', date: '2026-11-20' }]
  },
  {
    id: 'k-term-1', ws: 'ws-base', level: 'term', applies: '全团队', version: 'v1.1', updated: '1 周前', author: 'shenbeichen',
    title: '团队服务别名与口语术语表',
    sum: '统一团队口语简称（如 tk = refund-service、拆单台 = checkout-split）与正式仓库名的映射。',
    body: '- **拆单台 / checkout**：`pay/checkout-split`\n- **账单导出 / bill**：`pay/bill-export`\n- **幂等网关 / idem**：`pay/idem-gateway`\n- **公共契约 / proto**：`pay/common-proto`',
    hits: 17, useful: 9, staleCount: 0,
    traces: [],
    hist: [{ who: 'shenbeichen', act: '审核发布', ver: 'v1.1', date: '2026-11-12' }]
  }
];

export const INITIAL_PROPOSALS = [
  {
    id: 'pr-1', ws: 'ws-base', kind: 'knowledge', targetId: 'k-idem', level: 'exp', applies: 'pay/checkout-split',
    title: '回调幂等经验', author: 'zhangjingxin', time: '刚刚', status: 'pending',
    source: '会话「支付状态机回调时序核对」 · 本机 Agent 检索已有 3 条知识后自动归并差异',
    diff: [
      { t: 'ctx', x: '【解决方式】统一收敛到 idempotent(orderId, refundNo)，重入时直接返回首次成功载荷。' },
      { t: 'add', x: '【新增边界】job/compensate.ts 必须在获取租约锁后先走幂等闸门，禁止直接 UPDATE 退款单状态。' },
      { t: 'add', x: '【回归要求】新增 0 元抵扣券与并发重复投递两个单元测试用例。' }
    ]
  },
  {
    id: 'pr-map-1', ws: 'ws-base', kind: 'map', targetId: null, level: 'map', applies: '全团队',
    title: '系统地图更新：新增 pay/idem-gateway 调用证据', author: 'wangdalin', time: '25 分钟前', status: 'pending',
    source: '本机代码关系分析 · 附带 2 处证据路径',
    diff: [
      { t: 'ctx', x: 'pay/checkout-split ──[依赖契约]──> pay/common-proto' },
      { t: 'add', x: 'pay/checkout-split ──[幂等闸门 RPC]──> pay/idem-gateway (证据: src/state/refund.ts#L28)' },
      { t: 'add', x: 'pay/bill-export ──[读取流水]──> pay/checkout-split (标记: 推测，待核实)' }
    ]
  }
];

export const INITIAL_REQUESTS = [
  { id: 'rq1', kind: 'join', ws: 'ws-risk', from: 'wangdalin', time: '20 分钟前', status: 'pending', note: '需要参与大促风控联调，申请以开发者身份加入「风控联调专项组」。' },
  { id: 'rq2', kind: 'role', ws: 'ws-base', role: '管理员', from: 'wangdalin', time: '昨天 17:30', status: 'pending', note: '负责对账单与幂等方向的知识审核，申请 Workspace 管理员权限。' }
];

export const SYS_MAP = {
  version: 'v1.4', status: '已发布', publisher: 'zhangjingxin', updated: '2026-11-21',
  repos: [
    { name: 'pay/checkout-split', duty: '拆单支付与退款状态机', local: '~/work/pay/checkout-split', rel: [{ kind: '依赖契约', to: 'pay/common-proto', ev: 'package.json & proto.lock', sure: true }, { kind: '调用闸门', to: 'pay/idem-gateway', ev: 'src/state/refund.ts', sure: true }] },
    { name: 'pay/common-proto', duty: '跨服务错误码与 DTO 契约', local: '~/work/pay/common-proto', rel: [] },
    { name: 'pay/idem-gateway', duty: '分布式幂等锁与重入缓存', local: '', rel: [{ kind: '实现契约', to: 'pay/common-proto', ev: 'go.mod', sure: true }] },
    { name: 'pay/bill-export', duty: '大账单异步流式导出', local: '~/work/pay/bill-export', rel: [{ kind: '查询订单', to: 'pay/checkout-split', ev: '', sure: false }] }
  ]
};

export const MEM = {
  team: [
    { name: 'checkout-split', alias: '拆单台 / checkout', note: '核心拆单与退款状态机', source: '系统地图 v1.4' },
    { name: 'idem-gateway', alias: '幂等网关 / tk-idem', note: '提供幂等键闸门，本机尚未克隆', source: '系统地图 v1.4' },
    { name: 'bill-export', alias: '账单导出 / bill', note: '游标分片导出注意 highWaterMark 上限', source: '会话自动积累 (2 天前)' }
  ],
  personal: [
    { repo: 'pay/checkout-split', dir: '~/work/pay/checkout-split', status: '已验证 (Git remote 匹配)' },
    { repo: 'pay/common-proto', dir: '~/work/pay/common-proto', status: '已验证 (Git remote 匹配)' },
    { repo: 'pay/bill-export', dir: '~/work/pay/bill-export', status: '已验证 (1 处路径别名与地图待对齐)', conflict: true },
    { repo: 'pay/idem-gateway', dir: '', status: '本机未克隆' }
  ]
};

export const PLAYBOOKS = [
  {
    id: 'pb-bugfix', kind: 'Playbook · 缺陷排查', scope: 'ws-base', version: 'v1.2', status: '已发布',
    title: '支付回调与幂等缺陷定位',
    desc: '一键拉起 checkout-split + common-proto 双目录，预置规约与《回调幂等经验》，按“复现 → 定位 → 单测”推进。',
    dirs: ['~/work/pay/checkout-split', '~/work/pay/common-proto'],
    knowledge: ['接口错误码与金额整数分规约', '回调幂等经验'],
    prompt: '请帮我排查当前仓库的回调幂等或状态机异常：\n1. 先核对团队规约中的错误码与整数分约束；\n2. 定位入口与补偿路径的差异；\n3. 给出最小修复与回归单测。'
  },
  {
    id: 'pb-review', kind: 'Playbook · 变更审查', scope: 'ws-base', version: 'v2.0', status: '已发布',
    title: '上线前契约与安全红线自检',
    desc: '对照 Workspace 规约检查本地未提交改动与跨仓 proto 变更，输出可附在交付物卡片中的自检报告。',
    dirs: ['~/work/pay/checkout-split'],
    knowledge: ['接口错误码与金额整数分规约'],
    prompt: '请检查我当前工作区的未提交变更：\n1. 是否违反金额整数分或幂等错误码规约；\n2. 是否有脱敏遗漏或未覆盖的边界测试。'
  },
  {
    id: 'pb-sop-future', kind: 'SOP 扩展蓝图 · 未来形态', scope: '平台规划', version: 'Preview', status: '未来扩展位',
    title: '标准研发交付 SOP（扩展蓝图）',
    desc: '示意未来当 Harness Code 需要固化交付流程时，如何无缝挂载「需求澄清 → 方案 → 实现 → 人工关口 → 交付」多阶段流程入口而不破坏现有工作台布局。',
    dirs: ['~/work/pay/checkout-split'],
    knowledge: ['接口错误码与金额整数分规约', '团队服务别名与口语术语表'],
    prompt: '按标准交付流水线推进本需求：\nStage 1 澄清边界与验收标准 → Stage 2 输出改动计划待我确认 → Stage 3 实现并跑完回归测试。'
  }
];

export const ADMIN_DATA = {
  gateways: [
    { name: 'Claude Sonnet 4.5 (企业网关)', provider: 'Anthropic', status: '正常', quota: '已用 42% · 日限 500 万 Token', roleScope: '全团队可用' },
    { name: 'GPT-5 Codex (企业网关)', provider: 'OpenAI', status: '偶发波动', quota: '已用 68% · 仅管理员/后端', roleScope: '按角色下发' },
    { name: 'DeepSeek-V4.1 (内网通道)', provider: 'DeepSeek', status: '正常', quota: '不限额 · 默认兜底', roleScope: '全团队可用' }
  ],
  skillsMcp: [
    { name: 'harness-team-knowledge', type: '内置 MCP', status: '已审核启用', scope: '全团队', scan: '静态扫描通过（仅只读与记忆提案）' },
    { name: 'github-enterprise-readonly', type: '受控 MCP', status: '已审核启用', scope: 'pay/*', scan: '需成员个人 Token，禁止自动 push' },
    { name: 'sql-explain-helper', type: '团队 Skill', status: '待审核', scope: 'ws-base', scan: '包含本地 psql 只读命令，等待管理员放行' }
  ],
  audits: [
    { time: '10:14', actor: '张景新', action: '发布会话到 Project', target: '支付状态机回调时序核对 → 结账台拆分支付重构', mask: '已通过本机脱敏扫描（0 命中密钥）' },
    { time: '09:48', actor: '王大林', action: '提交系统地图提议', target: 'pay/checkout-split → pay/idem-gateway', mask: '仅含仓库路径证据，无个人上下文' },
    { time: '昨天 18:20', actor: '张景新', action: '审核发布团队知识', target: '接口错误码与金额整数分规约 v2.1', mask: '已触发成员标题目录缓存刷新' }
  ]
};
