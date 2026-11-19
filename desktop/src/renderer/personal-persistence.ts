/** 跟踪每个个人范围的最新修订；过期回包不能掩盖新保存的错误。 */
import type { PersonalHost, PersonalKey, PersonalRead, PersonalResult, PersonalValue } from "../shared/index.js"

export class PersonalPersistence {
  #revisions = new Map<string, number>()
  #loaded = new Set<string>()
  #pending = new Set<Promise<void>>()
  #failed = new Map<string, { key: PersonalKey; revision: number; value: PersonalValue }>()
  #generation = 0

  constructor(private readonly host: PersonalHost, private readonly notice: (message: string) => void) {}
  #key(key: PersonalKey): string { return JSON.stringify(key) }

  /** 重登后重新确认范围；旧账号迟到的结果不能进入当前窗口。 */
  reset(): void {
    this.#generation++
    this.#revisions.clear(); this.#loaded.clear(); this.#failed.clear()
    this.notice("")
  }

  async load(key: PersonalKey): Promise<PersonalResult<PersonalRead>> {
    const generation = this.#generation
    let result: PersonalResult<PersonalRead>
    try { result = await this.host.load(key) }
    catch { result = { ok: false, message: "无法读取个人视图，请重试。" } }
    if (generation !== this.#generation) return { ok: false, message: "账号已变化。" }
    if (!result.ok) { this.notice(result.message); return result }
    const canonical = this.#key(key)
    this.#loaded.add(canonical)
    this.#revisions.set(canonical, Math.max(this.#revisions.get(canonical) ?? 0, result.value.revision))
    if (!this.#failed.size) this.notice("")
    return result
  }

  save(key: PersonalKey, value: PersonalValue): void {
    const canonical = this.#key(key)
    if (!this.#loaded.has(canonical)) return
    const revision = (this.#revisions.get(canonical) ?? 0) + 1
    this.#revisions.set(canonical, revision)
    this.#send(canonical, { key, revision, value: structuredClone(value) })
  }

  /** 等待主进程确认标题写盘，关窗时也等待本次修改。 */
  async renameConversation(key: Extract<PersonalKey, { kind: "conversation" }>, title: string): Promise<PersonalResult<string>> {
    const generation = this.#generation
    const result = this.host.renameConversation(key, title)
      .catch(() => ({ ok: false, message: "会话标题保存失败，请重试。" } as const))
    const task = result.then(() => {}).finally(() => { this.#pending.delete(task) })
    this.#pending.add(task)
    const saved = await result
    return generation === this.#generation ? saved : { ok: false, message: "账号已变化。" }
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

  #retryFailed(canonical: string, record: { key: PersonalKey; revision: number; value: PersonalValue }): void {
    if (!this.#loaded.has(canonical)) return
    const generation = this.#generation
    let task: Promise<void>
    task = (async () => {
      try {
        const saved = await this.host.save(record.key, record.revision, record.value)
        if (generation !== this.#generation || this.#revisions.get(canonical) !== record.revision) return
        if (saved.ok) {
          this.#failed.delete(canonical)
          if (!this.#failed.size) this.notice("")
          return
        }
      } catch {
        // 首次直接重试抛异常时继续尝试通过 load 恢复主进程权限缓存。
      }

      // 兜底：若主进程权限缓存丢失，先 load 重建权限授权再按最新修订写回本地草稿。
      let reloaded: PersonalResult<PersonalRead>
      try {
        reloaded = await this.host.load(record.key)
      } catch {
        if (generation === this.#generation && this.#revisions.get(canonical) === record.revision) {
          this.notice("个人视图保存失败，请重试。")
        }
        return
      }
      if (generation !== this.#generation || this.#revisions.get(canonical) !== record.revision) return
      if (!reloaded.ok) {
        this.notice(reloaded.message)
        return
      }

      const nextRevision = Math.max(record.revision, reloaded.value.revision + 1)
      this.#revisions.set(canonical, nextRevision)
      try {
        const retried = await this.host.save(record.key, nextRevision, record.value)
        if (generation !== this.#generation || this.#revisions.get(canonical) !== nextRevision) return
        if (retried.ok) {
          this.#failed.delete(canonical)
          if (!this.#failed.size) this.notice("")
        } else {
          this.#failed.set(canonical, { ...record, revision: nextRevision })
          this.notice(retried.message)
        }
      } catch {
        if (generation === this.#generation && this.#revisions.get(canonical) === nextRevision) {
          this.#failed.set(canonical, { ...record, revision: nextRevision })
          this.notice("个人视图保存失败，请重试。")
        }
      }
    })().finally(() => { this.#pending.delete(task) })
    this.#pending.add(task)
  }

  /** 先等待所有在途保存，再用相同修订重试失败项；必要时先 load 恢复权限缓存。 */
  async flush(): Promise<boolean> {
    while (this.#pending.size) await Promise.all([...this.#pending])
    for (const [canonical, record] of [...this.#failed.entries()]) this.#retryFailed(canonical, record)
    while (this.#pending.size) await Promise.all([...this.#pending])
    return this.#failed.size === 0
  }
}
