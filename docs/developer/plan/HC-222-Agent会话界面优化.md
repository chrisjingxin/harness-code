# HC-222 Agent会话界面优化：实施计划

[Task](../task/HC-222-Agent会话界面优化.md) · [Spec](../spec/HC-222-Agent会话界面优化.md) · [Todo](../todo/HC-222-Agent会话界面优化.md)

## 1. 总体顺序

```text
停点 1：强调色公共出口 + 消息版面 + 动效基础
   └─ theme/accent.ts、accent.css、colors.css、base.css、desktop-workbench.tsx
      timeline.tsx（去头像、人右/Agent 左、回复底栏、新条目进入动效）
      rendering.css（代码块外观）、conversation.css
停点 2：工具日志与分组 + 思考自动折叠 + 状态与交互
   └─ timeline-model.ts（分组纯函数）、Disclosure、tool-card.tsx、interaction.tsx
      运行状态行归入当轮、请求区提醒色、回到底部药丸、重点折叠动效
      记录（2026-11-17）：Part A 已接通本机工具内容与思考（acp-runtime → IPC → 视图模型），仅本机展示不上传。
停点 3：左侧会话锚定
   └─ timeline-minimap.tsx、deriveMinimapItems、useTimelineScroll.scrollToEntry
      容器查询隐藏、roving tabindex、目标气泡高亮
```

每个停点结束都停下来，向用户说明怎么查看，等确认后再进入下一个停点。

## 2. 关键决策

- 分组和折叠只在前端推导，个人状态沿用现有的字符串列表，不改公开类型，也不改 HC-218 的数据转换。
- 折叠容器的组体始终挂载，用 grid-rows 做过渡，这样收起动画才能播放出来。单个工具的详情区内容较重，仍然在展开时才挂载，只做淡入。
- 新条目进入动效只对“挂载之后新出现的 id”生效，避免打开历史会话时整屏一起动。
- 锚点条用容器查询而不是视口媒体查询，右侧分屏挤压中央区域时也能自动隐藏。
- 待处理请求区用 1px 提醒色细边，不用 3px 粗左边线（impeccable craft-floor 不建议用超过 1px 的彩色侧边线）。

## 3. 验证方式

- 每个停点：`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`npm --workspace @workbench/desktop run build:conversation-preview`。
- 视觉：用 hc206 会话预览（`npm --workspace @workbench/desktop run dev:conversation-preview`）截图，检查浅色 / 深色与 1280 / 980 / 760 宽度。停点 2、3 还要检查系统“减少动态效果”下的表现。
- 停点 3 结束后：对 `packages/workbench-ui/src/conversation` 运行一次 `impeccable detect --json`，并冒烟一条“发送 → 工具组运行 → 思考收起 → 锚点跳回第一条 → 切换强调色”的正常路径。

## 4. 2026-11-17 会话阅读补充

复用公共文件类型图标和安全 Markdown → 在中央／右侧文件阅读器增加预览切换 → 调整返回按钮与浅／深语法色 → 构建、类型、边界及受控预览冒烟。图片与相对链接不新增宿主能力；完整平台验证仍由 HC-204 承接。

消息和工具详情的文件引用接入既有本机打开动作，明确路径限制在已绑定目录，单文件名复用已有文件搜索；同名时展示候选。同步调整图标并验证目录外拒绝与同名选择。
