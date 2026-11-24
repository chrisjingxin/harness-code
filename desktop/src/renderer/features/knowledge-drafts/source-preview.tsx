/** 起草前的完整选材预览；只展示来源端口给出的定稿与摘要，不加载工具完整输出。 */
import type { KnowledgeDraftSource } from "../../../shared/knowledge-drafts-host.js"

export function KnowledgeDraftSourcePreview({ turn }: { turn: KnowledgeDraftSource["turns"][number] }) {
  return <>
    <h4>用户消息</h4><pre>{turn.userText}</pre>
    {turn.followUps?.map((message, i) => <section key={i}>
      <h4>追发 {i + 1}</h4><time dateTime={new Date(message.occurredAtMs).toISOString()}>{new Date(message.occurredAtMs).toLocaleString()}</time><pre>{message.text}</pre>
    </section>)}
    {turn.tools?.map((tool, i) => <section key={i}>
      <h4>工具摘要：{tool.label}</h4>
      <p>{tool.name && <>名称：{tool.name} · </>}{tool.status === "failed" ? "失败" : "已完成"} · {tool.tone === "read" ? "读取" : tool.tone === "write" ? "写入" : "其他"} · <time dateTime={new Date(tool.occurredAtMs).toISOString()}>{new Date(tool.occurredAtMs).toLocaleString()}</time></p>
      {tool.summary && <pre>{tool.summary}</pre>}
    </section>)}
    <h4>终稿回复</h4><pre>{turn.reply}</pre>
  </>
}
