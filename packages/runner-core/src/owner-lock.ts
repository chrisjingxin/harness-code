/**
 * 单实例锁：owner.sqlite 独占事务真实持有到进程退出；第二个 Runner 明确失败。
 * 锁释放不代表旧执行结束，invoking 项仍按账本保持 unknown。
 */
import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export class OwnerLock {
  readonly #db: DatabaseSync
  #released = false
  private constructor(db: DatabaseSync) { this.#db = db }

  static acquire(path: string): OwnerLock {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA locking_mode = EXCLUSIVE")
    try {
      db.exec("BEGIN EXCLUSIVE")
      db.exec("CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, acquired_at INTEGER NOT NULL)")
      db.prepare("INSERT OR REPLACE INTO owner (id,acquired_at) VALUES (1,?)").run(Date.now())
      return new OwnerLock(db)
    } catch (error) {
      db.close()
      throw new Error("LOCAL_RUNNER_ALREADY_ACTIVE")
    }
  }

  release(): void {
    if (this.#released) return
    this.#released = true
    try { this.#db.exec("COMMIT") } catch { /* 已断开时只关闭句柄 */ }
    this.#db.close()
  }
}
