/** 固定知识版本的轻反馈；本人选择与公开合计来自服务端，页面打开不会上报 Agent 阅读。 */
import { useEffect, useRef, useState } from "react";
import type { KnowledgeFeedbackResponse } from "@workbench/collaboration-client/types";
import type { CollaborationAppsHost } from "../../../../shared/index.js";

/** 判断当前输入的反馈说明是否与服务端已保存内容存在未提交差异。 */
export function isFeedbackNoteDirty(
  result: Pick<KnowledgeFeedbackResponse, "value" | "note"> | undefined,
  draftNote: string,
): boolean {
  return Boolean(result?.value) && draftNote !== result?.note;
}

/** 撤销反馈时清空附带说明；其余反馈提交保留用户输入的说明文字。 */
export function resolveFeedbackSubmitNote(
  value: "useful" | "expired" | null,
  draftNote: string,
): string {
  return value === null ? "" : draftNote;
}

export function KnowledgeFeedback({ host, workspaceId, knowledgeId, versionId }: {
  host: CollaborationAppsHost;
  workspaceId: string;
  knowledgeId: string;
  versionId: string;
}) {
  const [result, setResult] = useState<KnowledgeFeedbackResponse>();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [savedNotice, setSavedNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const request = useRef({ key: "", id: "" });
  const running = useRef(false);

  useEffect(() => {
    active.current = true;
    setError("");
    setSavedNotice("");
    void host.readKnowledgeFeedback(workspaceId, knowledgeId, versionId).then(r => {
      if (!active.current) return;
      if (r.ok) {
        setResult(r.value);
        setNote(r.value.note);
      } else {
        setError(r.error.message);
      }
    });
    return () => { active.current = false; };
  }, [host, workspaceId, knowledgeId, versionId]);

  async function vote(v: "useful" | "expired" | null, options?: { readonly notifySaved?: boolean }) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setSavedNotice("");
    const submitNote = resolveFeedbackSubmitNote(v, note);
    const key = JSON.stringify([workspaceId, knowledgeId, versionId, v, submitNote]);
    if (request.current.key !== key) {
      request.current = { key, id: crypto.randomUUID() };
    }
    try {
      const r = await host.setKnowledgeFeedback(workspaceId, knowledgeId, versionId, {
        value: v,
        note: submitNote,
        requestId: request.current.id,
      });
      if (active.current) {
        if (r.ok) {
          setResult(r.value);
          if (v === null) setNote("");
          if (options?.notifySaved) setSavedNotice("说明已保存");
          request.current = { key: "", id: "" };
        } else {
          setError(r.error.message);
        }
      }
    } catch {
      if (active.current) {
        setError("反馈未能保存，请重试。");
      }
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }

  const noteDirty = isFeedbackNoteDirty(result, note);

  return (
    <div className="knowledge-feedback" aria-label="知识版本反馈">
      {result && (
        <small>
          本版 Agent 工具读取 {result.versionReadCount} 次 · 有用 {result.usefulCount} · 过期或有误 {result.expiredCount}
        </small>
      )}
      <div className="team-knowledge-presets">
        <button
          type="button"
          className="wb-button wb-button-secondary wb-button-small"
          disabled={busy}
          aria-pressed={result?.value === "useful"}
          onClick={() => void vote("useful")}
        >
          有用
        </button>
        <button
          type="button"
          className="wb-button wb-button-secondary wb-button-small"
          disabled={busy}
          aria-pressed={result?.value === "expired"}
          onClick={() => void vote("expired")}
        >
          已过期或有误
        </button>
        {result?.value && (
          <button
            type="button"
            className="wb-button wb-button-quiet wb-button-small"
            disabled={busy}
            onClick={() => void vote(null)}
          >
            撤销反馈
          </button>
        )}
      </div>
      <div className="knowledge-feedback-note">
        <input
          aria-label="反馈简短说明"
          placeholder={result?.value ? "补充说明（可选，按回车或离开输入框自动保存）" : "简短说明（可选，可先填写再点上方按钮）"}
          maxLength={280}
          disabled={busy}
          value={note}
          onChange={e => {
            setNote(e.target.value);
            if (savedNotice) setSavedNotice("");
          }}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && result?.value && noteDirty && !busy) {
              e.preventDefault();
              void vote(result.value, { notifySaved: true });
            }
          }}
          onBlur={e => {
            if (!result?.value || !noteDirty || busy) return;
            const related = e.relatedTarget;
            if (related instanceof Node && e.currentTarget.closest(".knowledge-feedback")?.contains(related)) {
              return;
            }
            void vote(result.value, { notifySaved: true });
          }}
        />
        {result?.value && noteDirty && (
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-small"
            disabled={busy}
            onClick={() => void vote(result.value!, { notifySaved: true })}
          >
            保存说明
          </button>
        )}
      </div>
      {savedNotice && !error && (
        <small role="status" className="knowledge-feedback-saved">{savedNotice}</small>
      )}
      {error && <p role="alert" className="team-knowledge-error">{error}</p>}
    </div>
  );
}
