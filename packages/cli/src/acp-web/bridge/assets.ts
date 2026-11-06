/**
 * ACP Web 桥的资源提供者：`AcpWebAssets` 类型、资源名白名单、S3-A 的占位页。
 *
 * 【这是做什么的？】
 * 桥不直接读文件系统：`GET /` 与 `GET /assets/<key>` 的内容全部由可注入的
 * `AcpWebAssetProvider` 提供。S3-A 只有一个占位页；S3-C 换成浏览器 bundle 时
 * 只改 `web-command.ts` 的一行默认值，桥本身不动。
 *
 * 【为什么 key 要白名单】
 * `/assets/<key>` 的 key 来自请求路径，把它映射到资源表之前必须保证它不可能
 * 参与路径拼接（不含 `/`、不含 `..`、不含 `%`、无大写、长度受限）：桥不用请求
 * 路径访问文件系统，但同样的白名单也挡住后续提供者把 key 拼进路径的实现失误。
 *
 * 【上下游】
 * 上游：`web-command.ts`（S3-A 传 `placeholderAssets`，S3-C 传浏览器 bundle）。
 * 下游：`bridge.ts` 在 `start()` 里调用一次并缓存，`assertValidAssets` 在启动时校验。
 */

/** `/assets/<key>` 单条资源。 */
export type AcpWebFile = {
  readonly contentType: string
  readonly body: string
}

export type AcpWebAssets = {
  readonly html: string
  /** key 就是 `/assets/<key>` 里的 `<key>`。 */
  readonly files: Readonly<Record<string, AcpWebFile>>
}

export type AcpWebAssetProvider = () => Promise<AcpWebAssets>

/** 资源名白名单：小写字母数字开头，之后可含 `._-`，最长 64。 */
export const ASSET_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * 启动时校验资源表：不合规的 key 直接抛错（fail closed，启动失败而不是
 * 请求期才出意外）。`..` 单独拒绝——它虽能过正则（`.` 在白名单里），但
 * 任何含 `..` 的 key 都是路径穿越形态。
 */
export function assertValidAssets(assets: AcpWebAssets): AcpWebAssets {
  for (const key of Object.keys(assets.files)) {
    if (!ASSET_KEY_PATTERN.test(key) || key.includes("..")) {
      throw new Error(`ACP Web 资源名无效: ${key}`)
    }
  }
  return assets
}

/**
 * S3-A 的默认提供者：一张没有脚本的占位页，足够证明桥的 HTTP 面可用
 * （`GET /` 返回 200 + 安全头），也让 `harness web` 在本段就能独立演示。
 */
export const placeholderAssets: AcpWebAssetProvider = async () => ({
  html: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Harness Code · ACP 桥</title>
</head>
<body>
  <main id="acp-placeholder">
    <p>Harness ACP 桥已启动，浏览器界面尚未打包。</p>
  </main>
</body>
</html>
`,
  files: {},
})
