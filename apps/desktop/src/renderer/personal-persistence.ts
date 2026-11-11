/** 跟踪每个个人范围的最新修订；过期回包不能掩盖新保存的错误。 */
import type { PersonalHost, PersonalKey, PersonalRead, PersonalResult, PersonalValue } from "../personal-host.js"

export class PersonalPersistence {
  #revisions = new Map<string, number>()
  #bindings = new Map<string, string>()
  #pending = new Set<Promise<void>>()
  #failed = new Map<string, { key: PersonalKey; revision: number; value: PersonalValue }>()
  #generation = 0

  constructor(private readonly host: PersonalHost, private readonly notice: (message: string) => void) {}
  #key(key: PersonalKey): string { return JSON.stringify(key) }

  /** 重登后重新确认范围；旧账号迟到的结果不能进入当前窗口。 */
  reset(): void {
    this.#generation++
    this.#revisions.clear(); this.#bindings.clear(); this.#failed.clear()
    this.notice("")
  }

  async load(key: PersonalKey): Promise<PersonalResult<PersonalRead>> {
    const generation = this.#generation
    let result: PersonalResult<PersonalRead>
    try { result = await this.host.load(key) }
    catch { result = { ok: false, message: "无法读取个人视图，请重试。" } }
    if (generation !== this.#generation) return { ok: false, message: "账号已变化。" }
    if (!result.ok) { this.notice(result.message); return result }
    const requested = this.#key(key)
    const canonical = key.kind === "project" && result.value.project
      ? JSON.stringify(["project", key.workspaceId, result.value.project.deviceId, result.value.project.projectId]) : requested
    this.#bindings.set(requested, canonical)
    this.#revisions.set(canonical, Math.max(this.#revisions.get(canonical) ?? 0, result.value.revision))
    if (!this.#failed.size) this.notice("")
    return result
  }

  save(key: PersonalKey, value: PersonalValue): void {
    const canonical = this.#bindings.get(this.#key(key))
    if (!canonical) return
    const revision = (this.#revisions.get(canonical) ?? 0) + 1
    this.#revisions.set(canonical, revision)
    this.#send(canonical, { key, revision, value: structuredClone(value) })
  }

  #send(canonical: string, record: { key: PersonalKey; revision: number; value: PersonalValue }): void {
    const generation = this.#generation
    let task: Promise<void>
    task = this.host.save(record.key, record.revision, record.value).then(result => {
      if (generation !== this.#generation || this.#revisions.get(canonical) !== record.revision) return
      if (result.ok) {
        this.#failed.delete(canonical)
        if (!this.#failed.size) this.notice("")
      } else { this.#failed.set(canonical, record); this.notice(result.message) }
    }).catch(() => {
      if (generation === this.#generation && this.#revisions.get(canonical) === record.revision) {
        this.#failed.set(canonical, record); this.notice("个人视图保存失败，请重试。")
      }
    }).finally(() => { this.#pending.delete(task) })
    this.#pending.add(task)
  }

  /** 先等待所有在途保存，再用相同修订重试失败项，避免旧值覆盖新值。 */
  async flush(): Promise<boolean> {
    while (this.#pending.size) await Promise.all([...this.#pending])
    for (const [canonical, record] of this.#failed) this.#send(canonical, record)
    while (this.#pending.size) await Promise.all([...this.#pending])
    return this.#failed.size === 0
  }
}
