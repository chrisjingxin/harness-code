/**
 * 测试团队成员仿真头像兜底映射：
 * 仅在服务端 user.photo 为空或远程头像加载失败时，按工号/姓名回退到随包静态人像。
 */
import avatar80278667 from "./assets/avatars/80278667.jpg"
import avatar80278668 from "./assets/avatars/80278668.jpg"
import avatar80278669 from "./assets/avatars/80278669.jpg"
import avatar80278670 from "./assets/avatars/80278670.jpg"
import avatar80278671 from "./assets/avatars/80278671.jpg"

const DEMO_AVATARS_BY_USER_NO: Record<string, string> = {
  "80278667": avatar80278667,
  "80278668": avatar80278668,
  "80278669": avatar80278669,
  "80278670": avatar80278670,
  "80278671": avatar80278671,
}

const DEMO_AVATARS_BY_USER_NAME: Record<string, string> = {
  "沈北辰": avatar80278667,
  "张景新": avatar80278668,
  "王大林": avatar80278669,
  "冯学茗": avatar80278670,
  "杨康": avatar80278671,
}

type AvatarUserLike = {
  photo?: string | null
  userNo?: string | null
  userName?: string | null
} | null | undefined

function isUsableAvatarUrl(raw: string): boolean {
  if (/^data:image\//i.test(raw)) return true
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("assets/")) return true
  try {
    const parsed = new URL(raw)
    return parsed.protocol === "http:"
      || parsed.protocol === "https:"
      || parsed.protocol === "file:"
      || parsed.protocol === "blob:"
  } catch {
    return false
  }
}

export function resolveFallbackDemoAvatar(user?: Pick<NonNullable<AvatarUserLike>, "userNo" | "userName"> | null): string | null {
  const userNo = user?.userNo?.trim()
  if (userNo && DEMO_AVATARS_BY_USER_NO[userNo]) return DEMO_AVATARS_BY_USER_NO[userNo]
  const userName = user?.userName?.trim()
  if (userName && DEMO_AVATARS_BY_USER_NAME[userName]) return DEMO_AVATARS_BY_USER_NAME[userName]
  return null
}

export function resolveUserPhoto(user?: AvatarUserLike): string | null {
  const explicit = user?.photo?.trim()
  if (explicit && isUsableAvatarUrl(explicit)) return explicit
  return resolveFallbackDemoAvatar(user)
}
