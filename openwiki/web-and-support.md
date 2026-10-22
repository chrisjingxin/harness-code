# 支持入口与故障分流

本页是 Web 工作台与本地诊断两个专题的入口，并给出「遇到问题先看哪里」的分流。深度的操作说明与排障步骤分别在对应专题页：

- [Web 工作台](web-ui.md)：`/web` 接管/重连/归还、token 保护、主题与状态、布局与控件、Composer/命令菜单、Markdown/代码、审批 Diff 与可访问性。
- [本地日志与离线诊断](diagnostics.md)：日志位置与文件生命周期、轮转清理、`[diagnostics]` 配置与级别、脱敏边界、`harness logs` 全部用法与错误码。
- [故障排查](troubleshooting.md)：按症状恢复，覆盖原指南全部 20 个排障主题与稳定错误码。

## 快速分流

| 症状 / 目标 | 去哪里 |
| --- | --- |
| Web 打不开、断开、token 失效、无法归还 TUI | [Web 工作台 §接管、重连与归还](web-ui.md#接管重连与归还)、[排障 §17](troubleshooting.md#17-web-工作台无法打开或立即断开) |
| Web 布局、主题、Diff、IME、命令菜单怎么用 | [Web 工作台](web-ui.md) 对应章节 |
| 查日志：目录、保留策略、级别开关 | [诊断页 §存储位置](diagnostics.md#存储位置文件命名与生命周期)、[§配置与级别](diagnostics.md#配置与级别) |
| 查日志：命令、过滤、cursor 续页、错误码 | [诊断页 §离线查询](diagnostics.md#离线查询harness-logs) |
| 模型/密钥、sidecar、OpenTUI、Plugin、文件 Snapshot、压缩、Pool 等其余故障 | [故障排查](troubleshooting.md) 对应编号主题 |
| 配置路径、`config path/show`、Profile 与密钥来源 | [配置页 §常见失败与安全恢复](configuration.md#常见失败与安全恢复) |

## 配置与日志的速查命令

确认配置位置与脱敏后的有效值（`api_key_source` 只会是 `environment|toml|missing`，不会显示密钥本身）：

```bash
npm run dev -- config path
npm run dev -- config show
```

确认输出的配置路径、默认 Profile 与 `api_key_source`，但不要输出或粘贴真实密钥；工作区 `.harness/config.toml` 被拒绝是预期保护，需迁移到用户级配置。配置模型与失败恢复详见[配置页](configuration.md)。

确认日志能离线读取（不启动 sidecar、不访问 SQLite、不写新日志）：

```bash
npm run dev -- logs
npm run dev -- logs --thread <prefix> --flat --limit 50
```

全部 flag、互斥规则、cursor 续页与错误码见[诊断页 §离线查询](diagnostics.md#离线查询harness-logs)。

## 请求帮助时提供什么

联系支持或提 Issue 前准备**脱敏后**的材料：

1. Harness 版本（顶栏或 `config show` 摘要中的版本信息）与操作系统；
2. 症状描述与稳定错误码（如 `CURSOR_EXPIRED`、`STALE_FILE`、Provider 终态码）；
3. 用 `npm run dev -- logs --thread <prefix> --flat` 或 `--json` 导出的相关片段——诊断日志本身已按脱敏红线排除 Prompt、模型正文、源码、凭据与绝对路径，但仍请复查企业专有命名后再发送；
4. **不要**包含：`~/.harness/config.toml` 内容、任何 token 或页面 URL（含 `#ui=` fragment）、密钥环境变量值、完整业务日志。
