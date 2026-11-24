/** 用户可见的本机知识起草动作；传会话/轮次标识，不接受路径、命令或发布权限。 */
import type { LocalAcpPermission, LocalAcpElicitationAnswer, LocalAcpElicitationRequest } from "@workbench/acp-runtime/types";
import type { CollaborationResult, KnowledgeProposalContent } from "@workbench/collaboration-client/types";
import type { LocalExecutionScope } from "./local-execution-host.js";
import type { LocalConversationToolSummary } from "./local-conversations-host.js";
export type KnowledgeDraftInput = {
  /** 来源选择标识；Project 定稿按消息序号和正文指纹生成，不承担 ACP 轮次映射。 */
  turnIds: readonly string[];
  kind: "conversation" | "maintenance";
};
/** 仅返回本人可选的定稿文本；目录与执行授权仍留在主进程。 */
export type KnowledgeDraftSource = {
  turns: readonly { turnId: string; userText: string; followUps?: readonly { text: string; occurredAtMs: number }[]; reply: string; tools?: readonly LocalConversationToolSummary[] }[];
  hasMore: boolean;
};
export type KnowledgeDraftState = {
  executionId: string;
  scope: LocalExecutionScope;
  status: "preparing" | "running" | "completed" | "cancelled" | "failed";
  message: string;
  candidates: readonly KnowledgeProposalContent[];
  searches: readonly {
    query: string;
    nextAfterId: string | null;
  }[];
  readReferences: readonly string[];
  permission: LocalAcpPermission | null;
  elicitation: LocalAcpElicitationRequest | null;
};
export interface KnowledgeDraftsHost {
  source(scope: LocalExecutionScope): Promise<CollaborationResult<KnowledgeDraftSource>>;
  start(scope: LocalExecutionScope, input: KnowledgeDraftInput): Promise<CollaborationResult<KnowledgeDraftState>>;
  read(executionId: string): Promise<CollaborationResult<KnowledgeDraftState>>;
  cancel(executionId: string): Promise<CollaborationResult<null>>;
  release(executionId: string): Promise<CollaborationResult<null>>;
  answerPermission(executionId: string, requestId: string, optionId: string): Promise<CollaborationResult<null>>;
  answerElicitation(executionId: string, requestId: string, answer: LocalAcpElicitationAnswer): Promise<CollaborationResult<null>>;
  onState(listener: (state: KnowledgeDraftState) => void): () => void;
}
