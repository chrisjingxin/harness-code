/** 可见的本机起草入口：选本人定稿 → 展示真实执行/审批 → 编辑结构化候选 → 本人确认提交。 */
import { useEffect, useRef, useState } from "react";
import type { KnowledgeDraftState, LocalExecutionScope, LocalConversationRecord, KnowledgeDraftSource } from "../../../shared/index.js";
import type { ConversationInteractionAnswer, ConversationPersonalState } from "../../../ui/index.js";
import { ConversationInteraction } from "../../../ui/conversation/interaction.js";
import { toConversationInteraction, toElicitationAnswer } from "../session/elicitation-form.js";
import { KnowledgeProposalEditor } from "../collaboration/knowledge/knowledge-governance.js";
import { KnowledgeDraftSourcePreview } from "./source-preview.js";
import "../collaboration/knowledge/team-knowledge.css";
function DraftElicitation({ run, onError }: {
  run: KnowledgeDraftState;
  onError(s: string): void;
}) {
  const [answers, setAnswers] = useState<Record<string, ConversationInteractionAnswer>>({});
  const request = run.elicitation!, recognized = toConversationInteraction(request);
  if (!recognized)
    return <><p>{request.message}</p><button className="wb-button wb-button-secondary" onClick={() => void window.knowledgeDrafts.answerElicitation(run.executionId, request.id, { action: "decline" }).then(r => { if (!r.ok)
      onError(r.error.message); })}>无法填写，退回请求</button></>;
  const personal: ConversationPersonalState = { scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null }, expandedTools: [], expandedOutputs: [], draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] }, interactions: answers };
  const submit = (answer: ConversationInteractionAnswer) => void window.knowledgeDrafts.answerElicitation(run.executionId, request.id, toElicitationAnswer(recognized.form, answer)).then(r => { if (!r.ok)
    onError(r.error.message); });
  return <ConversationInteraction scope={{ namespace: "knowledge-draft", accountId: run.scope.accountId, workspaceId: run.scope.workspaceId!, conversationId: run.executionId }} interaction={recognized.interaction} personal={personal} blocked={false} onSubmit={submit} actions={{ onPersonalChange: (_s, c) => { if (c.kind === "interaction")
      setAnswers(a => { const next = { ...a }; if (c.answer)
        next[c.interactionId] = c.answer;
      else
        delete next[c.interactionId]; return next; }); }, onInteractionSubmit: async () => { } }}/>;
}
export function KnowledgeDraftButton({ scope, workspaceId, accountId, disabled = false, maintenance = false }: {
  scope?: LocalExecutionScope;
  workspaceId: string;
  accountId: string;
  disabled?: boolean;
  maintenance?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={disabled} onClick={() => setOpen(true)}>{maintenance ? "让本机 Agent 整理" : "沉淀为团队知识"}</button>{open && <KnowledgeDraftDialog key={JSON.stringify([accountId, workspaceId, scope?.conversationId])} initialScope={scope} workspaceId={workspaceId} accountId={accountId} maintenance={maintenance} onClose={() => setOpen(false)}/>}</>;
}
function KnowledgeDraftDialog({ initialScope, workspaceId, accountId, maintenance, onClose }: {
  initialScope?: LocalExecutionScope;
  workspaceId: string;
  accountId: string;
  maintenance: boolean;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), runId = useRef<string | null>(null), starting = useRef(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [records, setRecords] = useState<readonly LocalConversationRecord[]>([]), [sourceScope, setSourceScope] = useState(initialScope), [turns, setTurns] = useState<KnowledgeDraftSource["turns"]>([]), [selected, setSelected] = useState<string[]>([]), [run, setRun] = useState<KnowledgeDraftState | null>(null), [error, setError] = useState(""), [candidate, setCandidate] = useState<number | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { active.current = true; dialog.current?.showModal(); const unsub = window.knowledgeDrafts.onState(s => { if (!active.current || s.scope.accountId !== accountId || s.scope.workspaceId !== workspaceId || !starting.current && s.executionId !== runId.current)
    return; if (sourceScope && s.scope.conversationId !== sourceScope.conversationId)
    return; runId.current = s.executionId; setRun(s); }); return () => { active.current = false; unsub(); dialog.current?.close(); if (runId.current)
    void window.knowledgeDrafts.release(runId.current); }; }, [accountId, workspaceId, sourceScope?.conversationId]);
  useEffect(() => { let current = true; void window.localConversations.list({ workspaceId, includePublished: true }).then(r => { if (current) {
    if (r.ok)
      setRecords(r.value.filter(x => x.directoryPath));
    else
      setError(r.error.message);
  } }); return () => { current = false; }; }, [workspaceId]);
  useEffect(() => { let current = true; setTurns([]); setSelected([]); setError(""); if (sourceScope && !maintenance)
    void window.knowledgeDrafts.source(sourceScope).then(r => { if (!current)
      return; if (r.ok) {
      const valid = r.value.turns;
      if(r.value.hasMore)setError("仅列出已读取的部分定稿，未包含整个会话。");
      setTurns(valid);
      if (valid.length)
        setSelected([valid[valid.length - 1].turnId]);
    }
    else
      setError(r.error.message); }); return () => { current = false; }; }, [sourceScope?.conversationId, sourceRevision, maintenance]);
  const running = run?.status === "running" || run?.status === "preparing" || busy;
  async function start() { if (!sourceScope || starting.current)
    return; starting.current = true; setBusy(true); setError(""); try {
    if (runId.current) {
      await window.knowledgeDrafts.release(runId.current);
      runId.current = null;
    }
    const r = await window.knowledgeDrafts.start(sourceScope, { kind: maintenance ? "maintenance" : "conversation", turnIds: maintenance ? [] : selected });
    if (!active.current) {
      if (r.ok)
        void window.knowledgeDrafts.release(r.value.executionId);
      return;
    }
    if (r.ok) {
      runId.current = r.value.executionId;
      setRun(prev => prev?.executionId === r.value.executionId && ["completed", "failed", "cancelled"].includes(prev.status) ? prev : r.value);
    }
    else
      setError(r.error.message);
  }
  catch (e) {
    if (active.current)
      setError(e instanceof Error ? e.message : "起草失败。");
  }
  finally {
    starting.current = false;
    if (active.current)
      setBusy(false);
  } }
  return <><dialog ref={dialog} className="team-knowledge-dialog knowledge-proposal-dialog" aria-label="本机知识起草" onCancel={e => { e.preventDefault(); onClose(); }}><h2>{maintenance ? "整理团队知识" : "从本机会话起草团队知识"}</h2><p>当前本机 Agent 将归纳所选材料并检索已有知识。起草使用独立临时会话及该 Agent 默认设置，内容仅形成候选。</p>{!initialScope && <label>选择本人可执行会话<select disabled={running} value={sourceScope?.conversationId ?? ""} onChange={e => { const r = records.find(x => x.conversationId === e.target.value); if (r)
    setSourceScope({ accountId, workspaceId, projectId: r.projectId, conversationId: r.conversationId }); }}><option value="">请选择已有本人会话</option>{records.map(r => <option key={r.conversationId} value={r.conversationId}>{r.title}</option>)}</select></label>}
  {!maintenance && <fieldset disabled={running}><legend>准备交给 Agent 的定稿轮次（最多64 KiB）</legend><button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => setSourceRevision(v => v + 1)}>重新读取定稿</button>{turns.length ? turns.map(t => <label className="knowledge-draft-turn" key={t.turnId}><input type="checkbox" checked={selected.includes(t.turnId)} onChange={e => setSelected(a => e.target.checked ? [...a, t.turnId] : a.filter(id => id !== t.turnId))}/>{t.userText.slice(0, 100)}<details><summary>查看本轮定稿材料</summary><KnowledgeDraftSourcePreview turn={t}/></details></label>) : <p>暂无可起草的完整定稿，请先完成一轮本机对话；刚完成的 Project 定稿等待共享成功后可重新读取。</p>}</fieldset>}
  {run && <section aria-label="知识起草状态"><p role="status">{run.message}</p>{run.permission && <section><h3>{run.permission.title}</h3>{run.permission.tool?.input && <pre>{run.permission.tool.input}</pre>}{run.permission.options.map(o => <button className="wb-button wb-button-secondary" key={o.id} onClick={() => void window.knowledgeDrafts.answerPermission(run.executionId, run.permission!.id, o.id).then(r => { if (!r.ok)
      setError(r.error.message); })}>{o.label}</button>)}</section>}{run.elicitation && <DraftElicitation key={run.elicitation.id} run={run} onError={setError}/>}
   <p>实际知识检索 {run.searches.length} 次 · 实际读取固定版本 {run.readReferences.length} 个</p>{run.searches.length > 0 && <details><summary>查看实际检索与读取记录</summary>{run.searches.map((s, i) => <p key={i}>{s.query || "全量标题页"}{s.nextAfterId ? "（仍有后续分页）" : "（本次返回无下一页）"}</p>)}{run.readReferences.map(r => <p key={r}>{r}</p>)}</details>}
   {run.status === "completed" && run.candidates.map((c, i) => <button className="wb-button wb-button-primary" key={i} onClick={() => setCandidate(i)}>编辑候选：{c.candidate.title}</button>)}
  </section>}{error && <p className="team-knowledge-error" role="alert">{error}</p>}<footer className="team-knowledge-dialog-footer"><button className="wb-button wb-button-secondary" onClick={onClose}>关闭</button>{running && run ? <button className="wb-button wb-button-secondary" onClick={() => void window.knowledgeDrafts.cancel(run.executionId).then(r => { if (!r.ok)
    setError(r.error.message); })}>停止起草</button> : <button className="wb-button wb-button-primary" disabled={busy || !sourceScope || !maintenance && !selected.length} onClick={() => void start()}>开始本机起草</button>}</footer></dialog>
  {run && candidate !== null && run.candidates[candidate] && <KnowledgeProposalEditor host={window.collaborationApps} workspaceId={workspaceId} accountId={accountId} admin={false} initial={run.candidates[candidate]} onClose={() => setCandidate(null)} onSaved={() => { }}/>}
 </>;
}
