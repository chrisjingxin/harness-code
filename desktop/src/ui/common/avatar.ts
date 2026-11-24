/**
 * 安全头像 URL 校验（UI 层共用）：
 * 仅允许安全位图 Data URI、站内相对路径以及 http/https/file/blob 协议，拦截 svg/javascript 等危险载体。
 */
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;

export function safeAvatarUrl(photo?: string | null): string | null {
  if (!photo) return null;
  if (SAFE_DATA_IMAGE_RE.test(photo)) return photo;
  if (
    (photo.startsWith("/") && !photo.startsWith("//"))
    || photo.startsWith("./")
    || photo.startsWith("../")
    || photo.startsWith("assets/")
  ) {
    return photo;
  }
  try {
    const url = new URL(photo);
    return url.protocol === "https:"
      || url.protocol === "http:"
      || url.protocol === "file:"
      || url.protocol === "blob:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
