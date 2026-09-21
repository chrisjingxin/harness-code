# Harness Code（za38-cli）

Harness Code 是面向企业研发场景的 Coding Agent CLI。终端交互由 Node.js/Ink 提供，Agent 内核基于 Python、deepagents、LangChain 和 LangGraph，并通过 stdio JSON-RPC 通信。

## 安装

把 `scripts/install/install.sh` 与 `install.ps1` 顶部的企业 npm / PyPI 默认地址填好，托管到企业安装入口后，用户只执行：

macOS / Linux：

```bash
curl -fsSL https://<企业安装入口>/install.sh | bash
```

Windows（必须用 PowerShell，不要用 CMD 或 Git Bash）：

```powershell
irm https://<企业安装入口>/install.ps1 | iex
```

用户不用先配环境变量。脚本会检测 Node.js >=20、npm >=10、Python 3.11+ 和 uv，Node 缺失时提示通过企业渠道安装，uv/Python 缺了就安装。装完进入任意项目目录：

```bash
export HARNESS_API_KEY='你的企业网关密钥'
harness
```

已有 Node.js/npm 和 uv 时也可以手动安装：

```bash
npm install -g @za38/cli --registry <企业 npm>
uv tool install za38-agent --index <企业 PyPI>
```

卸载：`npm uninstall -g @za38/cli` 与 `uv tool uninstall za38-agent`。不卸载本机 Node/npm/uv/Python，也不删除 `~/.harness/config.toml`。

当前未发布到可访问的包源时，安装命令会在 `npm install -g` 失败；开发请用下面的源码方式。Linux musl 与 Windows ARM 本版本不支持。

## 从源码开发

本地开发固定使用 Node.js `>=20`、npm `10.9.3`、Python 3.11+ 和 `uv`。先在企业索引环境中同步锁定的 Agent 依赖，再复制用户级示例配置并将 API Key 放入指定环境变量：

```bash
mkdir -p ~/.harness
cd packages/agent && uv sync --extra test && cd ../..
cp docs/user/examples/config.toml ~/.harness/config.toml
export HARNESS_API_KEY='你的企业网关密钥'
npm run dev
```

推荐通过 `api_key_env` 引用环境变量。若本机开发环境无法预先设置环境变量，可在权限为 `0600` 的 `~/.harness/config.toml` 模型 Profile 中设置 `api_key` 作为降级值；环境变量非空时始终优先。

可使用 `harness --help` 或 `npm run dev -- --help` 查看当前 CLI 参数；无头运行示例：

```bash
harness -n --message "解释当前目录的项目结构"
npm run dev -- --non-interactive --message "解释当前目录的项目结构"
```

详细说明：

- [快速开始](docs/user/快速开始.md)
- [模型配置](docs/user/模型配置.md)
- [交互使用](docs/user/交互使用.md)
- [代码索引](docs/user/代码索引.md)
- [插件管理](docs/user/插件管理.md)
- [完整 Plugin Demo](examples/plugins/harness-full-demo/README.md)
- [安全与沙箱](docs/user/安全与沙箱.md)
- [故障排查](docs/user/故障排查.md)

终端界面基于 Ink `6.8.0` 与 React `19.2.6`，采用主屏原生滚屏与键盘优先交互，不再依赖 Bun 或 OpenTUI 本地原生绑定。

参与开发请从 [开发工作流](docs/developer/project/开发工作流.md) 开始；任务以 [任务看板](docs/developer/task/任务看板.md) 和任务源文件为准。
