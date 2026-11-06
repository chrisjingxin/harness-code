/** ACP 入口的 HTML 外壳：只引用 /assets/*，不内嵌脚本和凭据。 */

export const acpWebHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Harness Code</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <div id="root"><main class="web-static-state"><p>正在启动本地 Agent…</p></main></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>
`
