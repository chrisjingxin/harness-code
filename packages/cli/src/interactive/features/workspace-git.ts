/** 人工 Git Feature：共享 busy 与提交/推送分离结果，不经模型执行。 */
import { emptyWorkspaceGitView, type WorkspaceGit, type WorkspaceGitView } from "../ports/workspace-git"
import type { InteractiveIntent, InteractiveSnapshot, IntentOutcome } from "../types"
export type GitIntent = Extract<InteractiveIntent, {type: `git.${string}`}>
/** 共享服务端与 UI 的 Git 写入门禁；未完成 Compose/Goal 不允许手动写仓库。 */
export function gitWriteBlockedReason(snapshot: Pick<InteractiveSnapshot,"activeRun"|"interaction"|"connection"|"activity"|"composeState"|"goal"|"goalPending"|"confirmation">): string | null {
  if (snapshot.connection.status !== "open") return "连接尚未就绪。"
  if (snapshot.activeRun || snapshot.interaction || snapshot.confirmation || snapshot.activity.kind === "compacting") return "当前任务或交互结束后才能提交。"
  if (snapshot.composeState && !["completed","abandoned"].includes(snapshot.composeState.status)) return "请先完成当前 Compose 流程。"
  if (snapshot.goal?.status === "active" || snapshot.goalPending) return "请先暂停或完成当前 Goal。"
  return null
}
/** 持有可重连的人工 Git 状态和互斥锁。 */
export class WorkspaceGitFeature {
  view: WorkspaceGitView = emptyWorkspaceGitView()
  constructor(private readonly port: WorkspaceGit | undefined) {}
  /** 同步加锁后再 await，TUI/Web 均能观察并拒绝并发写入。 */
  async execute(intent: GitIntent, blocked: string | null, publish:()=>void): Promise<IntentOutcome> {
    if (this.view.busy) return {status:"rejected",code:"busy",message:"Git 操作进行中，请稍候。"}
    if (!this.port) return {status:"rejected",code:"capability-missing",message:"当前没有可用的本地 Git 服务。"}
    const writing = intent.type === "git.commit" || intent.type === "git.push"
    if (writing && blocked) return {status:"rejected",code:"busy",message:blocked}
    if (intent.type === "git.commit" && intent.push && !this.view.repository?.upstream) return {status:"rejected",code:"invalid-argument",message:"请先在终端配置当前分支 upstream。"}
    this.view = {...this.view,busy:true,error:null}; publish()
    try {
      if (intent.type === "git.refresh") this.view = {...this.view,repository:await this.port.status(),diff:null}
      if (intent.type === "git.diff") this.view = {...this.view,diff:await this.port.diff(intent.snapshot,intent.path)}
      if (intent.type === "git.commit") {
        const result=await this.port.commit(intent)
        this.view={...this.view,result:{...result,pushed:false},diff:null}
        publish()
        this.view={...this.view,repository:await this.port.status()}
        if (intent.push && !result.warning) {
          try { await this.port.push({snapshot:this.view.repository!.snapshot,head:result.sha});this.view={...this.view,result:{...result,pushed:true}} }
          catch (error) { this.view={...this.view,result:{...result,pushed:false,pushError:message(error)}} }
        }
      }
      if (intent.type === "git.push") {
        if (this.view.result?.sha !== intent.head) throw new Error("只能重试当前已确认成功提交的推送，请刷新后检查。")
        await this.port.push(intent)
        this.view={...this.view,result:{sha:intent.head,pushed:true,...(this.view.result.warning ? {warning:this.view.result.warning} : {})}}
      }
      if (writing) this.view={...this.view,repository:await this.port.status()}
      return {status:"accepted"}
    } catch (error) {
      this.view={...this.view,error:message(error)}
      if (writing) {
        try { this.view={...this.view,repository:await this.port.status(),diff:null} } catch {}
      }
      return {status:"rejected",code:"invalid-argument",message:message(error)}
    } finally { this.view={...this.view,busy:false};publish() }
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : "Git 操作失败，请在终端检查。" }
