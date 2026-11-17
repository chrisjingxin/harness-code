/** 团队知识独立预览。条目、固定版本和读取动作均由本页提供。 */
import { createRoot } from "react-dom/client"
import { BrandMark } from "@workbench/ui"
import { snapshotReferenceView } from "../../../../apps/desktop/src/renderer/features/collaboration/references/conversation-references.js"
import { TeamKnowledge } from "../../../../apps/desktop/src/renderer/features/collaboration/knowledge/team-knowledge.js"
import type {
  KnowledgeActions,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeVersionContent,
} from "../../../../apps/desktop/src/renderer/features/collaboration/knowledge/team-knowledge.js"
import "@workbench/ui/theme.css"
import "./preview.css"

const scope: KnowledgeScope = { namespace: "hc219-knowledge-preview", accountId: "zhang", teamId: "demo-team" }
const items: readonly KnowledgeItem[] = [
  { id: "idempotency", title: "接口幂等规约" },
  { id: "error-codes", title: "错误码命名约定" },
]
const referenceAvailability = { enabled: false, reason: "本人会话引用入口待接入。" }
const versionOne: KnowledgeVersionContent = {
  itemId: "idempotency",
  versionId: "idempotency-v1",
  versionLabel: "v1",
  author: "李四",
  updatedAt: "2026-11-11 14:30",
  referenceAvailability,
  reference: snapshotReferenceView({
    id: "idempotency-v1",
    title: "接口幂等规约",
    owner: "李四",
    version: "v1",
    uploadedAt: "2026-11-11 14:30",
    rangeLabel: "固定版本",
    text: "### 基本原则\n\n- 同一业务操作使用稳定的请求号。\n- 超时后先查询结果，再决定是否重试。",
  }),
}
const versionTwo: KnowledgeVersionContent = {
  itemId: "idempotency",
  versionId: "idempotency-v2",
  versionLabel: "v2",
  author: "王五",
  updatedAt: "2026-11-13 10:20",
  referenceAvailability,
  reference: snapshotReferenceView({
    id: "idempotency-v2",
    title: "接口幂等规约",
    owner: "王五",
    version: "v2",
    uploadedAt: "2026-11-13 10:20",
    rangeLabel: "固定版本",
    text: "### 基本原则\n\n- 重试时沿用首次业务请求号。\n- 超时先查询结果，状态未知时等待确认。\n- 重复请求返回首次处理结果。",
  }),
}
const errorCodeVersion: KnowledgeVersionContent = {
  itemId: "error-codes",
  versionId: "error-codes-v1",
  versionLabel: "v1",
  author: "张三",
  updatedAt: "2026-11-12 11:00",
  referenceAvailability,
  reference: snapshotReferenceView({
    id: "error-codes-v1",
    title: "错误码命名约定",
    owner: "张三",
    version: "v1",
    uploadedAt: "2026-11-12 11:00",
    rangeLabel: "固定版本",
    text: "### 命名\n\n错误码使用稳定的业务语义，并在接口文档中说明处理方式。",
  }),
}
const versions = [versionTwo, versionOne, errorCodeVersion]
const currentVersions = new Map([
  ["idempotency", versionTwo],
  ["error-codes", errorCodeVersion],
])

const actions: KnowledgeActions = {
  async readCurrent(_scope, itemId) {
    const version = currentVersions.get(itemId)
    return version ? { status: "ready", value: version } : { status: "unavailable", message: "示例条目不可用。" }
  },
  async readHistory(_scope, itemId) {
    return {
      status: "ready",
      value: versions.filter(version => version.itemId === itemId).map(version => ({
        id: version.versionId,
        label: version.versionLabel,
        author: version.author,
        updatedAt: version.updatedAt,
      })),
    }
  },
  async readVersion(_scope, itemId, versionId) {
    const version = versions.find(value => value.itemId === itemId && value.versionId === versionId)
    return version ? { status: "ready", value: version } : { status: "unavailable", message: "示例版本不可用。" }
  },
}

function Preview() {
  return (
    <main>
      <header className="hc219-knowledge-preview-header">
        <BrandMark />
        <p>团队知识预览 · 固定示例</p>
      </header>
      <TeamKnowledge
        scope={scope}
        teamName="研发协作组"
        items={{ status: "ready", value: items }}
        actions={actions}
      />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Preview />)
