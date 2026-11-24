/** 将真实完成的知识工具结果投影为固定版本芯片及轻反馈；渲染与回放均不上报读取计数。 */
import type { ConversationTimelineEntry } from "../../../../ui/index.js";
import type { CollaborationAppsHost } from "../../../../shared/index.js";
import { KnowledgeFeedback } from "./knowledge-feedback.js";
const fixed = /^knowledge:([0-9a-f-]{36}):([0-9a-f-]{36})$/;
function result(value: unknown, depth = 0): {
  referenceId: string;
  title: string;
  version: number;
} | null {
  if (depth > 4)
    return null;
  if (typeof value === "string") {
    try {
      return result(JSON.parse(value), depth + 1);
    }
    catch {
      return null;
    }
  }
  if (!value || typeof value !== "object")
    return null;
  const r = value as Record<string, unknown>;
  if (typeof r.referenceId === "string" && fixed.test(r.referenceId) && typeof r.title === "string" && typeof r.version === "number")
    return { referenceId: r.referenceId, title: r.title, version: r.version };
  for (const key of ["structuredContent", "result", "content"]) {
    const child = r[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        const found = result(c, depth + 1);
        if (found)
          return found;
      }
    }
    else {
      const found = result(child, depth + 1);
      if (found)
        return found;
    }
  }
  return typeof r.text === "string" ? result(r.text, depth + 1) : null;
}
export function withKnowledgeToolFeedback(entries: readonly ConversationTimelineEntry[], host: CollaborationAppsHost, workspaceId: string, accountId: string): readonly ConversationTimelineEntry[] {
  return entries.map(entry => {
    if (entry.kind !== "tool" || entry.status !== "completed")
      return entry;
    const material = result(entry.detail?.outputText);
    if (!material)
      return entry;
    const ref = fixed.exec(material.referenceId)!;
    return { ...entry, detail: { ...entry.detail, extension: <>{entry.detail?.extension}<span className="team-knowledge-reference-id">{material.title} · 固定版本 v{material.version}</span><KnowledgeFeedback key={JSON.stringify([accountId, workspaceId, material.referenceId])} host={host} workspaceId={workspaceId} knowledgeId={ref[1]} versionId={ref[2]}/></> } };
  });
}
