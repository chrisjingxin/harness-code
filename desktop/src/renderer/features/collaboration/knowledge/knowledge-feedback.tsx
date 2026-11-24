/** 固定知识版本的轻反馈；本人选择与公开合计来自服务端，页面打开不会上报 Agent 阅读。 */
import { useEffect, useRef, useState } from "react";
import type { KnowledgeFeedbackResponse } from "@workbench/collaboration-client/types";
import type { CollaborationAppsHost } from "../../../../shared/index.js";
export function KnowledgeFeedback({ host, workspaceId, knowledgeId, versionId }: {
  host: CollaborationAppsHost;
  workspaceId: string;
  knowledgeId: string;
  versionId: string;
}) {
  const [result, setResult] = useState<KnowledgeFeedbackResponse>(), [note, setNote] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const active = useRef(true), request = useRef({ key: "", id: "" }), running = useRef(false);
  useEffect(() => { active.current = true; void host.readKnowledgeFeedback(workspaceId, knowledgeId, versionId).then(r => { if (!active.current)
    return; if (r.ok) {
    setResult(r.value);
    setNote(r.value.note);
  }
  else
    setError(r.error.message); }); return () => { active.current = false; }; }, [host, workspaceId, knowledgeId, versionId]);
  async function vote(v: "useful" | "expired" | null) { if (running.current)
    return; running.current = true; setBusy(true); setError(""); const key = JSON.stringify([workspaceId, knowledgeId, versionId, v, note]); if (request.current.key !== key)
    request.current = { key, id: crypto.randomUUID() }; try {
    const r = await host.setKnowledgeFeedback(workspaceId, knowledgeId, versionId, { value: v, note, requestId: request.current.id });
    if (active.current) {
      if (r.ok) {
        setResult(r.value);
        request.current = {key:"",id:""};
      }
      else
        setError(r.error.message);
    }
  }
  catch {
    if (active.current)
      setError("反馈未能保存，请重试。");
  }
  finally {
    running.current = false;
    if (active.current)
      setBusy(false);
  } }
  return <div className="knowledge-feedback" aria-label="知识版本反馈">{result && <small>本版 Agent 工具读取 {result.versionReadCount} 次 · 有用 {result.usefulCount} · 过期或有误 {result.expiredCount}</small>}<div className="team-knowledge-presets"><button className="wb-button wb-button-secondary wb-button-small" disabled={busy} aria-pressed={result?.value === "useful"} onClick={() => void vote("useful")}>有用</button><button className="wb-button wb-button-secondary wb-button-small" disabled={busy} aria-pressed={result?.value === "expired"} onClick={() => void vote("expired")}>已过期或有误</button>{result?.value && <button className="wb-button wb-button-quiet wb-button-small" disabled={busy} onClick={() => void vote(null)}>撤销反馈</button>}</div><input aria-label="反馈简短说明" placeholder="简短说明（可选）" maxLength={280} value={note} onChange={e => setNote(e.target.value)}/>{error && <p role="alert" className="team-knowledge-error">{error}</p>}</div>;
}
