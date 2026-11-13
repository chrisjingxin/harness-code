/**
 * 测试团队成员仿真头像兜底映射：
 * 仅在服务端 user.photo 为空时按工号回退到随包静态人像（遵循 desktop CSP `img-src 'self' data:`）。
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

export function resolveUserPhoto(user?: { photo?: string | null; userNo?: string | null } | null): string | null {
  const explicit = user?.photo?.trim()
  if (explicit) return explicit
  const userNo = user?.userNo?.trim()
  return (userNo && DEMO_AVATARS_BY_USER_NO[userNo]) || null
}
