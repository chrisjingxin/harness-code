/** 比较和摘要前去掉回车。Windows 检出的 CRLF 与 LF 视为同一文本。 */

export function withoutCarriageReturn(text) {
  return text.replaceAll("\r", "")
}
