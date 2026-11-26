/**
 * 管理与设置导航模型（HC-255）：
 * 仅收敛当前桌面端与服务端已真实落地的设置分区，不预留未接入后端的空壳占位项。
 */

export type AdminSectionId = "appearance" | "agents" | "notifications" | "memory" | "account" | "team"

export type AdminNavItem = {
  readonly id: AdminSectionId
  readonly label: string
}

export type AdminNavGroup = {
  readonly label: string
  readonly items: readonly AdminNavItem[]
}

export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  {
    label: "个人与本机",
    items: [
      { id: "appearance", label: "外观、密度与快捷键" },
      { id: "agents", label: "本机 Agent" },
      { id: "notifications", label: "通知与提醒" },
      { id: "memory", label: "本机项目记忆" },
    ],
  },
  {
    label: "账号与团队",
    items: [
      { id: "account", label: "账号与登录" },
      { id: "team", label: "成员角色与仓库" },
    ],
  },
]

export const ADMIN_SECTION_META: Readonly<Record<AdminSectionId, { readonly title: string; readonly subtitle: string }>> = {
  appearance: {
    title: "外观、密度与快捷键",
    subtitle: "设置浅/深色主题、全局强调色、界面阅读密度、窗口缩放比例与常用键盘快捷键。",
  },
  agents: {
    title: "本机 Agent",
    subtitle: "查看本机已探测的 ACP Agent 驱动连通状态，支持重新检测与排查可执行路径配置。",
  },
  notifications: {
    title: "通知与提醒",
    subtitle: "管理跨团队协作的外部 IM 轻通知开关、订阅事件、免打扰时段与合批窗口，对话正文绝不外传。",
  },
  memory: {
    title: "本机项目记忆",
    subtitle: "查看和编辑当前团队的两份本机 Markdown 记忆，供本人会话使用（HC-256）。",
  },
  account: {
    title: "账号与登录",
    subtitle: "查看当前登录身份、协作服务连接地址，或切换与退出当前账号。",
  },
  team: {
    title: "成员角色与仓库",
    subtitle: "管理当前协作空间成员与管理员权限、离职交接清单，以及团队仓库负责人登记（HC-240）。",
  },
}
