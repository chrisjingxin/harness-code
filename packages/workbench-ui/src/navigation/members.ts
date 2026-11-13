/**
 * 成员分组规则：项目成员名单 + 会话条目 → 按稳定所有者标识归组 → 排序、空态与搜索展开 → 左栏可直接渲染的组。
 * 只处理已加载数据，不发请求，也不解释同步含义；桌面装配与受控预览共用这一处规则。
 */

/** 项目成员的显示资料；`userId` 是唯一分组依据，显示名可能重复。 */
export type NavigationMember = {
  userId: string;
  displayName: string;
  username: string;
  /** 已移出项目的成员只在仍有可见会话时出现。 */
  left: boolean;
};

/** 左栏会话行；所有者、标题和同步标识由会话模块提供。 */
export type NavigationSessionEntry = {
  conversationId: string;
  ownerUserId: string;
  title: string;
  timeLabel: string;
  /** 行内标识文本与语气由会话模块决定，例如"未同步""有更新""只读"。 */
  badge?: { text: string; tone: "neutral" | "accent" | "warning" | "danger" };
};

export type NavigationMemberGroup = {
  userId: string;
  label: string;
  /** 同名成员附带用户名以便区分。 */
  detail?: string;
  initial: string;
  self: boolean;
  left: boolean;
  expanded: boolean;
  /** 搜索期间折叠按钮暂不可用，避免改动已保存的折叠状态。 */
  toggleable: boolean;
  sessions: readonly NavigationSessionEntry[];
  /** 当前显示的会话少于该成员全部已加载会话时为 true（搜索过滤）。 */
  filtered: boolean;
};

export type MemberGroupInput = {
  members: readonly NavigationMember[];
  entries: readonly NavigationSessionEntry[];
  selfUserId: string;
  expandedMembers: readonly string[];
  selfCollapsed: boolean;
  search: string;
};

const collator = new Intl.Collator("zh-CN");

/** 未在成员名单里的所有者（例如名单刷新前出现的新会话）用标识前缀兜底显示。 */
function unknownMember(userId: string): NavigationMember {
  return { userId, displayName: `成员 ${userId.slice(0, 8)}`, username: "", left: false };
}

export function buildMemberGroups(input: MemberGroupInput): NavigationMemberGroup[] {
  const query = input.search.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(query);
  const byOwner = new Map<string, NavigationSessionEntry[]>();
  for (const entry of input.entries) {
    const list = byOwner.get(entry.ownerUserId);
    if (list) list.push(entry);
    else byOwner.set(entry.ownerUserId, [entry]);
  }
  const members = new Map(input.members.map((member) => [member.userId, member]));
  for (const owner of byOwner.keys()) if (!members.has(owner)) members.set(owner, unknownMember(owner));
  // 已离开且没有会话的成员不再占位；本人即使不在名单里也保留"我的会话"。
  const visible = [...members.values()].filter(
    (member) => member.userId === input.selfUserId || !member.left || byOwner.has(member.userId),
  );
  if (!members.has(input.selfUserId)) visible.push({ ...unknownMember(input.selfUserId), displayName: "我" });
  const nameCount = new Map<string, number>();
  for (const member of visible) nameCount.set(member.displayName, (nameCount.get(member.displayName) ?? 0) + 1);
  visible.sort((a, b) => {
    if (a.userId === input.selfUserId || b.userId === input.selfUserId) return a.userId === input.selfUserId ? -1 : 1;
    if (a.left !== b.left) return a.left ? 1 : -1;
    return collator.compare(a.displayName, b.displayName) || collator.compare(a.username, b.username);
  });
  const groups: NavigationMemberGroup[] = [];
  for (const member of visible) {
    const self = member.userId === input.selfUserId;
    const label = self ? "我的会话" : member.displayName;
    const all = byOwner.get(member.userId) ?? [];
    let sessions: readonly NavigationSessionEntry[] = all;
    if (query) {
      const nameHit = matches(label) || matches(member.displayName) || (member.username !== "" && matches(member.username));
      if (!nameHit) sessions = all.filter((entry) => matches(entry.title));
      if (!nameHit && sessions.length === 0) continue;
    }
    groups.push({
      userId: member.userId,
      label,
      ...(!self && member.username && (nameCount.get(member.displayName) ?? 0) > 1 ? { detail: member.username } : {}),
      initial: (member.displayName || "?").slice(0, 1),
      self,
      left: member.left,
      expanded: query ? true : self ? !input.selfCollapsed : input.expandedMembers.includes(member.userId),
      toggleable: !query,
      sessions,
      filtered: sessions.length !== all.length,
    });
  }
  return groups;
}
