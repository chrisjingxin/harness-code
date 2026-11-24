/**
 * 团队知识的提议、审核与复核页面；复用当前知识样式和固定版本读取。
 * 本人编辑并确认共享 → 待审；管理员比较固定基线 → 发布/退回。所有权限最终由服务端复核。
 */
import { useEffect, useRef, useState } from "react";
import type * as K from "@workbench/collaboration-client/types";
import type { CollaborationAppsHost } from "../../../../shared/index.js";
import { Markdown } from "../../../../ui/index.js";
import { ProjectGitDiff } from "../../../../ui/project/git-diff.js";
import { readPages } from "../metadata.js";
import { resolveKnowledgeTermKey } from "./knowledge-key.js";
export const levelNames: Record<K.KnowledgeLevel, string> = { rule: "规约", experience: "经验", term: "术语" };
const stateNames: Record<string, string> = { draft: "草稿", submitted: "待审核", returned: "已退回", published: "已发布", withdrawn: "已撤回" };
export const blankCandidate = (): K.KnowledgeCandidate => ({ termKey: "", category: "经验", title: "", text: "", level: "experience", scope: { kind: "workspace", repositoryIds: [] }, contentType: "article" });
export const publishedCandidate = (d: K.KnowledgeDetail): K.KnowledgeCandidate => ({ termKey: d.item.termKey, category: d.current.version.category, title: d.current.version.title, text: d.current.text, level: d.current.version.level, scope: d.current.version.scope, contentType: d.current.version.contentType });
export const blankProposal = (): K.KnowledgeProposalContent => ({ intent: "new", targetKnowledgeId: null, baseVersionId: null, baseItemVersion: null, candidate: blankCandidate(), relatedReferences: [], sourceSummary: "", sourceRefs: [], generationKind: "manual" });
export async function value<T>(p: Promise<K.CollaborationResult<T>>): Promise<T> { const r = await p; if (!r.ok)
  throw new Error(r.error.message); return r.value; }
/** 相同动作/载荷失败后重试复用编号，避免网络丢回执后重复创建或发布。 */
function useRequestId() { const keys = useRef(new Map<string, string>()); return (payload: unknown) => { const key = JSON.stringify(payload); let id = keys.current.get(key); if (!id) {
  id = crypto.randomUUID();
  keys.current.set(key, id);
} return id; }; }
export function KnowledgeScopeFields({ workspaceId, scope, onChange, disabled = false }: {
  workspaceId: string;
  scope: K.KnowledgeScope;
  onChange(scope: K.KnowledgeScope): void;
  disabled?: boolean;
}) {
  const [repos, setRepos] = useState<K.RepositorySummary[]>([]), [error, setError] = useState("");
  useEffect(() => { let active = true; void window.organization.listRepositories(workspaceId).then(r => { if (!active)
    return; if (r.ok)
    setRepos(r.value.repositories.filter(x => x.status === "active"));
  else
    setError(r.error.message); }); return () => { active = false; }; }, [workspaceId]);
  return <><label>适用范围<select disabled={disabled} value={scope.kind} onChange={e => onChange({ kind: e.target.value as K.KnowledgeScope["kind"], repositoryIds: [] })}><option value="workspace">全团队</option><option value="repositories">指定团队仓库</option></select></label>{scope.kind === "repositories" && <fieldset disabled={disabled}><legend>适用仓库（可多选）</legend>{repos.map(r => <label key={r.repositoryId}><input type="checkbox" checked={scope.repositoryIds.includes(r.repositoryId)} onChange={e => onChange({ kind: "repositories", repositoryIds: (e.target.checked ? [...scope.repositoryIds, r.repositoryId] : scope.repositoryIds.filter(id => id !== r.repositoryId)).sort() })}/>{r.name}</label>)}{!repos.length && <p>{error || "没有可选择的活跃仓库。"}</p>}</fieldset>}</>;
}
export function KnowledgeCandidateFields({ workspaceId, candidate, onChange, disabled = false, fixedKey = false }: {
  workspaceId: string;
  candidate: K.KnowledgeCandidate;
  onChange(c: K.KnowledgeCandidate): void;
  disabled?: boolean;
  fixedKey?: boolean;
}) {
  const update = <P extends keyof K.KnowledgeCandidate>(key: P, v: K.KnowledgeCandidate[P]) => onChange({ ...candidate, [key]: v });
  return <fieldset className="project-task-fields" disabled={disabled}><label>标题<input value={candidate.title} maxLength={200} onChange={e => update("title", e.target.value)}/></label><label>级别<select value={candidate.level} onChange={e => update("level", e.target.value as K.KnowledgeLevel)}>{Object.entries(levelNames).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select></label><KnowledgeScopeFields workspaceId={workspaceId} scope={candidate.scope} disabled={disabled} onChange={v => update("scope", v)}/><label>主题标签<input value={candidate.category} maxLength={80} onChange={e => update("category", e.target.value)}/></label><label>知识键<input value={candidate.termKey} readOnly={fixedKey} placeholder="可留空，按标题生成" maxLength={64} onChange={e => update("termKey", e.target.value)}/></label><label>正文<textarea rows={10} value={candidate.text} maxLength={16384} onChange={e => update("text", e.target.value)}/></label>{candidate.level === "rule" && <p className="team-knowledge-field-hint">规约应短小，提交和发布正文最多4 KiB；超限草稿仍可保存。</p>}</fieldset>;
}
function diff(before: string, after: string) { const a = before.split("\n"), b = after.split("\n"); return `--- 基准版本\n+++ 提议版本\n@@ -1,${a.length} +1,${b.length} @@\n${a.map(s => "-" + s).join("\n")}\n${b.map(s => "+" + s).join("\n")}`; }
export function KnowledgeProposalEditor({ host, workspaceId, accountId, admin, initial, existing, onClose, onSaved }: {
  host: CollaborationAppsHost;
  workspaceId: string;
  accountId: string;
  admin: boolean;
  initial?: K.KnowledgeProposalContent;
  existing?: K.KnowledgeProposalDetail;
  onClose(): void;
  onSaved(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), inFlight = useRef(false), request = useRequestId();
  const [content, setContent] = useState(initial ?? existing?.proposal.content ?? blankProposal()), [detail, setDetail] = useState(existing), [base, setBase] = useState<K.KnowledgeVersion | null>(null), [items, setItems] = useState<K.KnowledgeSummary[]>([]), [note, setNote] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const p = detail?.proposal.proposalId ? detail.proposal : undefined, owner = !p || p.proposerId === accountId, editable = owner && (!p || ["draft", "returned"].includes(p.status)), reviewable = Boolean(admin && p?.status === "submitted"), canEdit = editable || reviewable;
  useEffect(() => { active.current = true; dialog.current?.showModal(); return () => { active.current = false; dialog.current?.close(); }; }, []);
  useEffect(() => { let current = true; void readPages(id => host.listKnowledge(workspaceId, "", id), r => r.items, () => current).then(r => { if (current)
    setItems(r); }).catch(e => { if (current)
    setError(e.message); }); return () => { current = false; }; }, [host, workspaceId]);
  useEffect(() => { let current = true; if (content.targetKnowledgeId && content.baseVersionId)
    void host.readKnowledgeVersion(workspaceId, content.targetKnowledgeId, content.baseVersionId).then(r => { if (current) {
      if (r.ok)
        setBase(r.value);
      else
        setError(r.error.message);
    } });
  else
    setBase(null); return () => { current = false; }; }, [host, workspaceId, content.targetKnowledgeId, content.baseVersionId]);
  async function run(action: () => Promise<void>) { if (inFlight.current)
    return; inFlight.current = true; setBusy(true); setError(""); try {
    await action();
  }
  catch (e) {
    if (active.current)
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
  }
  finally {
    inFlight.current = false;
    if (active.current)
      setBusy(false);
  } }
  async function selectTarget(id: string, keepText = false) { await run(async () => { if (!id) {
    setContent(c => ({ ...c, intent: "new", targetKnowledgeId: null, baseVersionId: null, baseItemVersion: null }));
    return;
  } const r = await value(host.readKnowledge(workspaceId, id)); if (!active.current)
    return; setBase(r.current); setContent(c => ({ ...c, intent: c.intent === "new" ? "supplement" : c.intent, targetKnowledgeId: id, baseVersionId: r.item.currentVersionId, baseItemVersion: r.item.version, candidate: { ...publishedCandidate(r), text: keepText ? c.candidate.text : r.current.text }, relatedReferences: [...c.relatedReferences.filter(x => x.knowledgeId !== id), { knowledgeId: id, versionId: r.item.currentVersionId }] })); }); }
  async function save(submit: boolean) {
    await run(async () => {
      const resolved = resolveKnowledgeTermKey(content.candidate.title, content.candidate.termKey);
      if (!resolved.valid)
        throw new Error(resolved.error || "知识键格式有误。");
      const next = { ...content, candidate: { ...content.candidate, termKey: resolved.termKey } };
      let saved: K.KnowledgeProposalDetail;
      if (!p) {
        const payload = { content: next, submit };
        saved = await value(host.createKnowledgeProposal(workspaceId, { ...payload, requestId: request(payload) }));
      }
      else {
        saved = detail!;
        if (JSON.stringify(next) !== JSON.stringify(p.content)) {
          const payload = { content: next, expectedRevision: p.revision };
          saved = await value(host.editKnowledgeProposal(workspaceId, p.proposalId, { ...payload, requestId: request(payload) }));
          if (active.current) {
            setDetail(saved);
            setContent(saved.proposal.content);
          }
        }
        if (submit) {
          const payload = { expectedRevision: saved.proposal.revision, confirmShare: true };
          saved = await value(host.submitKnowledgeProposal(workspaceId, p.proposalId, { ...payload, requestId: request(payload) }));
        }
      }
      if (active.current) {
        setDetail(saved);
        setContent(saved.proposal.content);
        onSaved();
        if (submit)
          onClose();
      }
    });
  }
  async function review(decision: "approve" | "return") { if (!p)
    return; await run(async () => { const changed = JSON.stringify(content.candidate) !== JSON.stringify(p.content.candidate), payload = { decision, expectedRevision: p.revision, baseVersionId: p.content.baseVersionId, expectedItemVersion: p.content.baseItemVersion, finalCandidate: changed ? content.candidate : null, note }; const r = await value(host.reviewKnowledgeProposal(workspaceId, p.proposalId, { ...payload, requestId: request(payload) })); if (active.current) {
    setDetail(r);
    onSaved();
    onClose();
  } }); }
  return <dialog ref={dialog} className="team-knowledge-dialog knowledge-proposal-dialog" aria-label="团队知识提议" onCancel={e => { e.preventDefault(); if (!busy)
    onClose(); }}><h2>{p ? stateNames[p.status] : "团队知识草稿"}</h2>{p?.lastReason && <p role="status">退回理由：{p.lastReason}</p>}{p && !p.proposerActive && <p>提议人的团队资格已变化，需要重新提议。</p>}
  <fieldset className="project-task-fields" disabled={busy || !editable}><label>提议方式<select value={content.intent} onChange={e => setContent(c => ({ ...c, intent: e.target.value as K.KnowledgeProposalContent["intent"] }))}><option value="new">新增</option><option value="supplement">补充已有知识</option><option value="conflict">冲突修订</option><option value="archive">建议归档</option></select></label>{content.intent !== "new" && <label>目标知识<select value={content.targetKnowledgeId ?? ""} onChange={e => void selectTarget(e.target.value)}><option value="">请选择目标</option>{items.map(i => <option key={i.knowledgeId} value={i.knowledgeId}>{i.title} · v{i.version}</option>)}</select></label>}</fieldset>
  <KnowledgeCandidateFields workspaceId={workspaceId} candidate={content.candidate} disabled={busy || !canEdit} fixedKey={Boolean(content.targetKnowledgeId)} onChange={candidate => setContent(c => ({ ...c, candidate }))}/>
  <label className="knowledge-source-summary">共享来源摘要<textarea rows={3} maxLength={2000} value={content.sourceSummary} disabled={busy || !editable} onChange={e => setContent(c => ({ ...c, sourceSummary: e.target.value }))}/></label><p className="team-knowledge-field-hint">提交会将正文、适用范围和此摘要交给管理员；个人会话原文不会自动上传。</p>
  {base && <details open><summary>相对固定基准 v{base.version.version} 的差异</summary><ProjectGitDiff text={diff(base.text, content.candidate.text)}/>{editable && <button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void selectTarget(base.knowledgeId, true)}>重新读取当前版本并比较</button>}</details>}
  {reviewable && JSON.stringify(content.candidate) !== JSON.stringify(p?.content.candidate) && <details open><summary>审核人的修改</summary><ProjectGitDiff text={diff(p!.content.candidate.text, content.candidate.text)}/></details>}
  {!canEdit && <Markdown text={content.candidate.text}/>}
  {detail?.events.length ? <details><summary>提交与审核记录</summary>{detail.events.map(e => <div key={e.eventId}><strong>{stateNames[e.kind] ?? e.kind}</strong> · {new Date(e.occurredAtMs).toLocaleString()}<p>{e.note}</p><details><summary>当时提交的正文</summary><Markdown text={e.content.candidate.text}/></details></div>)}{detail.nextAfterId && <button className="wb-button wb-button-secondary" onClick={() => void run(async () => { const r = await value(host.readKnowledgeProposal(workspaceId, p!.proposalId, detail.nextAfterId)); if (active.current)
    setDetail({ ...r, events: [...detail.events, ...r.events] }); })}>更多记录</button>}</details> : null}
  {reviewable && <label>审核说明（退回或修改后批准必填）<textarea value={note} maxLength={1000} onChange={e => setNote(e.target.value)}/></label>}
  {error && <p role="alert" className="team-knowledge-error">{error}</p>}
  <footer className="team-knowledge-dialog-footer">{p&&((owner&&p.status==="withdrawn")||(admin&&p.submittedAtMs!==null&&!p.proposerActive))&&<button className="wb-button wb-button-secondary" disabled={busy} onClick={()=>{setContent({...p.content,generationKind:"manual",sourceRefs:[...p.content.sourceRefs,{kind:"proposal",referenceId:p.proposalId,projectId:null,revision:p.revision}]});setDetail(undefined)}}>复制为新草稿</button>}<button className="wb-button wb-button-secondary" disabled={busy} onClick={onClose}>关闭</button>{editable && <><button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void save(false)}>保存草稿</button><button className="wb-button wb-button-primary" disabled={busy} onClick={() => void save(true)}>确认共享并提交审核</button></>}{owner && p && ["draft", "returned", "submitted"].includes(p.status) && <button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void run(async () => { const payload = { expectedRevision: p.revision, confirmShare: false }; await value(host.withdrawKnowledgeProposal(workspaceId, p.proposalId, { ...payload, requestId: request(payload) })); if (active.current) {
    onSaved();
    onClose();
  } })}>撤回</button>}{reviewable && <><button className="wb-button wb-button-secondary" disabled={busy || !note.trim()} onClick={() => void review("return")}>退回</button><button className="wb-button wb-button-primary" disabled={busy || !p?.proposerActive} onClick={() => void review("approve")}>{JSON.stringify(content.candidate) === JSON.stringify(p?.content.candidate) ? "批准并发布" : "修改后批准并发布"}</button></>}</footer>
 </dialog>;
}
export function KnowledgeGovernance({ host, workspaceId, accountId, admin, view, onChanged }: {
  host: CollaborationAppsHost;
  workspaceId: string;
  accountId: string;
  admin: boolean;
  view: "mine" | "review" | "recheck";
  onChanged(): void;
}) {
  const [rows, setRows] = useState<K.KnowledgeProposalSummary[]>([]), [queue, setQueue] = useState<K.KnowledgeSummary[]>([]), [revision, setRevision] = useState(0), [error, setError] = useState(""), [editing, setEditing] = useState<K.KnowledgeProposalDetail | null | undefined>(undefined), [review, setReview] = useState<K.KnowledgeReviewDetail | null>(null), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const active = useRef(true), request = useRequestId();
  useEffect(() => () => { active.current = false; }, []);
  const changed = () => { setRevision(r => r + 1); onChanged(); };
  useEffect(() => { let current = true; setError(""); setRows([]); setQueue([]); const load = view === "recheck" ? readPages(id => host.listKnowledgeReviews(workspaceId, id), r => r.items, () => current).then(r => { if (current)
    setQueue(r); }) : readPages(id => host.listKnowledgeProposals(workspaceId, view, view === "review" ? "submitted" : null, id), r => r.items, () => current).then(r => { if (current)
    setRows(r); }); void load.catch(e => { if (current)
    setError(e.message); }); return () => { current = false; }; }, [host, workspaceId, view, revision]);
  async function run(fn: () => Promise<void>) { if (busy)
    return; setBusy(true); setError(""); try {
    await fn();
  }
  catch (e) {
    if (active.current)
      setError(e instanceof Error ? e.message : "操作失败。");
  }
  finally {
    if (active.current)
      setBusy(false);
  } }
  return <section className="knowledge-governance"><h2>{view === "mine" ? "我的提议" : view === "review" ? "待审核" : "待复核"}</h2>{view === "mine" && <button className="wb-button wb-button-primary" onClick={() => setEditing(null)}>新建提议</button>}<button className="wb-button wb-button-secondary" onClick={changed}>刷新</button>{error && <p className="team-knowledge-error" role="alert">{error}</p>}
  <ul className="knowledge-governance-list">{rows.map(r => <li key={r.proposalId}><button className="wb-button wb-button-quiet" disabled={busy} onClick={() => void run(async () => { const d = await value(host.readKnowledgeProposal(workspaceId, r.proposalId, null)); if (active.current)
    setEditing(d); })}>{r.title} · {levelNames[r.level]} · {stateNames[r.status]}{!r.proposerActive ? " · 资格已变化" : ""}</button></li>)}{queue.map(r => <li key={r.knowledgeId}><button className="wb-button wb-button-quiet" disabled={busy} onClick={() => void run(async () => { const d = await value(host.readKnowledgeReview(workspaceId, r.knowledgeId, null)); if (active.current) {
    setReview(d);
    setNote("");
  } })}>{r.title} · {r.health.lastReviewedAtMs === null ? "尚未复核" : "到期或有未处理反馈"} · {r.health.expiredCount}条过期/错误反馈</button></li>)}</ul>{!rows.length && !queue.length && <p>暂无条目。</p>}
  {editing !== undefined && <KnowledgeProposalEditor host={host} workspaceId={workspaceId} accountId={accountId} admin={admin} existing={editing ?? undefined} onClose={() => setEditing(undefined)} onSaved={changed}/>}
  {review && <section className="knowledge-review-detail"><h3>{review.item.title}</h3><p>最近复核：{review.item.health.lastReviewedAtMs ? new Date(review.item.health.lastReviewedAtMs).toLocaleString() : "尚未复核"} · 有用{review.item.health.usefulCount} · 过期/错误{review.item.health.expiredCount}</p>{review.events.map(e => <p key={e.eventId}>{e.kind === "feedback" ? (e.value === "expired" ? "过期或有误" : e.value === "useful" ? "有用" : "撤销反馈") : "管理员确认有效"} · {e.note} · {new Date(e.occurredAtMs).toLocaleString()}</p>)}{review.nextAfterId && <button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void run(async () => { const d = await value(host.readKnowledgeReview(workspaceId, review.item.knowledgeId, review.nextAfterId)); if (active.current)
    setReview({ ...d, events: [...review.events, ...d.events] }); })}>更多反馈与复核记录</button>}<label>复核说明<textarea value={note} maxLength={1000} onChange={e => setNote(e.target.value)}/></label><div className="team-knowledge-dialog-footer"><button className="wb-button wb-button-primary" disabled={busy || !note.trim()} onClick={() => void run(async () => { const payload = { expectedItemVersion: review.item.version, currentVersionId: review.item.currentVersionId, feedbackWatermark: review.item.health.feedbackWatermark, action: "confirmed_valid" as const, note }; const d = await value(host.confirmKnowledgeReview(workspaceId, review.item.knowledgeId, { ...payload, requestId: request(payload) })); if (active.current) {
    setReview(d);
    changed();
  } })}>已核对，仍有效</button><button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void run(async () => { const d = await value(host.readKnowledge(workspaceId, review.item.knowledgeId)); if (active.current)
    setEditing({ proposal: { proposalId: "", workspaceId, proposerId: accountId, content: { ...blankProposal(), intent: "supplement", targetKnowledgeId: d.item.knowledgeId, baseVersionId: d.item.currentVersionId, baseItemVersion: d.item.version, candidate: publishedCandidate(d) }, revision: 1, status: "draft", createdAtMs: 0, updatedAtMs: 0, submittedAtMs: null, lastReason: "", publishedKnowledgeId: null, publishedVersionId: null, reviewerId: null, outcome: "", proposerActive: true }, events: [], nextAfterId: null }); })}>发起修订</button><button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void run(async () => { await value(host.archiveKnowledge(workspaceId, review.item.knowledgeId, review.item.version, request(["archive", review.item.knowledgeId, review.item.version]))); if (active.current) {
    setReview(null);
    changed();
  } })}>归档当前条目</button><button className="wb-button wb-button-secondary" onClick={() => setReview(null)}>关闭</button></div></section>}
 </section>;
}
