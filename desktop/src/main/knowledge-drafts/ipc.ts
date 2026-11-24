/** 起草业务的可信窗口 IPC；只接受已知标识和具名动作，不接受命令、目录或云端发布载荷。 */
import type { BrowserWindow } from "electron";
import type { LocalAcpElicitationAnswer } from "@workbench/acp-runtime";
import type { LocalExecutionScope } from "../../shared/local-execution-host.js";
import { createCollaborationIpcRegistrar, formatIpcError, isPlainObject, isUserId, isUuid } from "../ipc-guard.js";
import type { KnowledgeDraftService } from "./service.js";
const scope = (s: unknown): s is LocalExecutionScope => isPlainObject(s) && Object.keys(s).every(k => ["accountId", "workspaceId", "projectId", "conversationId"].includes(k)) && isUserId(s.accountId) && isUuid(s.conversationId) && isUuid(s.workspaceId) && (s.projectId === null || isUuid(s.projectId));
export function bindKnowledgeDraftIpc(window: BrowserWindow, trustedUrl: string, service: KnowledgeDraftService) {
  const ipc = createCollaborationIpcRegistrar({ window, trustedUrl, messages: { sourceRejected: "不允许的起草请求来源。", invalidRequest: "起草参数无效。", internalError: "起草操作失败。" } });
  const invalid = () => formatIpcError("INVALID_REQUEST", "起草参数无效。");
  const run = async <T>(fn: () => T | Promise<T>) => { try {
    return { ok: true as const, value: await fn() };
  }
  catch (e) {
    return formatIpcError("INVALID_REQUEST", e instanceof Error ? e.message : "起草失败。");
  } };
  ipc.handle("workbench:knowledge-drafts:source", 1, s => scope(s) ? run(() => service.source(s)) : invalid());
  ipc.handle("workbench:knowledge-drafts:start", 2, (s, input) => scope(s) && isPlainObject(input) && Object.keys(input).every(k => ["kind", "turnIds"].includes(k)) && ["conversation", "maintenance"].includes(String(input.kind)) && Array.isArray(input.turnIds) && input.turnIds.length <= 100 && input.turnIds.every(isUuid) && new Set(input.turnIds).size === input.turnIds.length ? run(() => service.start(s, { kind: input.kind as "conversation" | "maintenance", turnIds: input.turnIds as string[] })) : invalid());
  ipc.handle("workbench:knowledge-drafts:read", 1, id => isUuid(id) ? run(() => service.read(id)) : invalid());
  ipc.handle("workbench:knowledge-drafts:cancel", 1, id => isUuid(id) ? run(async () => { await service.cancel(id); return null; }) : invalid());
  ipc.handle("workbench:knowledge-drafts:release", 1, id => isUuid(id) ? run(async () => { await service.release(id); return null; }) : invalid());
  ipc.handle("workbench:knowledge-drafts:permission", 3, (id, requestId, optionId) => isUuid(id) && typeof requestId === "string" && requestId.length <= 1024 && typeof optionId === "string" && optionId.length <= 1024 ? run(async () => { await service.answerPermission(id, requestId, optionId); return null; }) : invalid());
  ipc.handle("workbench:knowledge-drafts:elicitation", 3, (id, requestId, answer) => {
    if (!isUuid(id) || typeof requestId !== "string" || !isPlainObject(answer) || !Object.keys(answer).every(k => ["action", "content"].includes(k)) || !["accept", "decline", "cancel"].includes(String(answer.action)) || JSON.stringify(answer).length > 16384)
      return invalid();
    if (answer.content !== undefined && (!isPlainObject(answer.content) || Object.values(answer.content).some(v => typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean" && !(Array.isArray(v) && v.every(x => typeof x === "string")))))
      return invalid();
    return run(async () => { await service.answerElicitation(id, requestId, answer as LocalAcpElicitationAnswer); return null; });
  });
  return () => ipc.dispose();
}
