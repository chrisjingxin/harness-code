/**
 * Runner 本地账本：node:sqlite + WAL + FULL；首次命令、原决定、连续来源与待确认结果同库持久化。
 * 任何写失败都向上抛出并停止发送；绝不以内存状态替代未知执行。
 */
import { DatabaseSync } from "node:sqlite"
import { chmodSync, lstatSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  ExecutionStartMessage, ExecutionStartDecisionMessage, ExecutionCancelMessage,
  ExecutionTerminalMessage, ExecutionRunnerMessage, CancelBeforeStartRecord, ResumeRecord, LocalExecutionRecord, LocalDeviceRegistration,
} from "@workbench/contracts"

export type LocalState = "stored" | "accepted" | "decisionStored" | "invoking" | "running" | "terminalStored" | "unknown"

export interface ExecutionRecord {
  id: string
  start: ExecutionStartMessage
  decision: ExecutionStartDecisionMessage | null
  cancel: ExecutionCancelMessage | null
  state: LocalState
  nativeSessionId: string | null
  lastRunnerSequence: string
  lastCommittedSequence: string
  terminal: ExecutionTerminalMessage | null
  createdAt: number
  updatedAt: number
}

export interface OutboxItem { messageId: string; executionId: string; sequence: string | null; message: ExecutionRunnerMessage }

export class Ledger {
  readonly #db: DatabaseSync
  readonly #path: string
  #inTransaction = false

  private constructor(path: string) {
    this.#path = path
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const file = lstatSync(path, { throwIfNoEntry: false })
    if (file && (!file.isFile() || (process.platform !== "win32" && (file.mode & 0o077) !== 0))) throw new Error("LEDGER_MISMATCH")
    this.#db = new DatabaseSync(path)
    if (process.platform !== "win32") chmodSync(path, 0o600)
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA synchronous = FULL")
    this.#db.exec("PRAGMA fullfsync = ON")
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution (
        id TEXT PRIMARY KEY,
        start_json TEXT NOT NULL,
        start_body_sha256 TEXT NOT NULL,
        decision_json TEXT,
        cancel_json TEXT,
        state TEXT NOT NULL,
        native_session_id TEXT,
        last_runner_sequence INTEGER NOT NULL DEFAULT 0,
        last_committed_sequence INTEGER NOT NULL DEFAULT 0,
        terminal_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        message_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        runner_sequence INTEGER,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project (
        id TEXT PRIMARY KEY,
        root_ref TEXT NOT NULL,
        root_path TEXT NOT NULL,
        name TEXT NOT NULL,
        share_enabled INTEGER NOT NULL,
        share_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS occupancy (
        root_ref TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_execution ON outbox (execution_id, runner_sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS uk_execution_start ON execution (json_extract(start_json,'$.messageId'));
      CREATE UNIQUE INDEX IF NOT EXISTS uk_execution_input ON execution (json_extract(start_json,'$.payload.inputId'));
      CREATE UNIQUE INDEX IF NOT EXISTS uk_outbox_sequence ON outbox (execution_id, runner_sequence);
      CREATE TABLE IF NOT EXISTS cancel_before_start (
        execution_id TEXT PRIMARY KEY,
        cancel_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uk_early_start ON cancel_before_start (json_extract(cancel_json,'$.cancel.payload.startCommandId'));
      CREATE UNIQUE INDEX IF NOT EXISTS uk_early_input ON cancel_before_start (json_extract(cancel_json,'$.cancel.payload.inputId'));
      CREATE INDEX IF NOT EXISTS idx_execution_state ON execution (state, updated_at);
    `)
  }

  static open(path: string): Ledger { return new Ledger(path) }

  get path(): string { return this.#path }

  /** 实际宿主能力探测：读回引擎、WAL/FULL 与写事务，失败即拒绝启动。 */
  probe(): { sqlite: string; journalMode: string; synchronous: string; previousProbe: string | null; probeValue: string } {
    const version = this.#db.prepare("SELECT sqlite_version() AS value").get() as { value: string }
    const journal = this.#db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    const sync = this.#db.prepare("PRAGMA synchronous").get() as { synchronous: number }
    const previous = this.#db.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as { value: string } | undefined
    this.transaction(() => {
      this.#db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("probe", String(Date.now()))
    })
    const probe = this.#db.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as { value: string } | undefined
    if (!probe || journal.journal_mode !== "wal" || sync.synchronous !== 2) throw new Error("LEDGER_WRITE_FAILED")
    return { sqlite: version.value, journalMode: journal.journal_mode, synchronous: String(sync.synchronous), previousProbe: previous?.value ?? null, probeValue: probe.value }
  }

  /** 已存在的账本只能由原登记继续使用。 */
  requireIdentity(ledgerId: string, initialize = false): void {
    const current = this.#db.prepare("SELECT value FROM meta WHERE key = 'ledgerId'").get() as { value: string } | undefined
    if (current) {
      if (current.value !== ledgerId) throw new Error("LEDGER_MISMATCH")
      return
    }
    if (!initialize || this.#db.prepare("SELECT id FROM execution LIMIT 1").get()
      || this.#db.prepare("SELECT execution_id FROM cancel_before_start LIMIT 1").get()) {
      throw new Error("LEDGER_MISMATCH")
    }
    this.#db.prepare("INSERT INTO meta (key,value) VALUES ('ledgerId',?)").run(ledgerId)
  }

  close(): void { this.#db.close() }

  /** 凭据与归属跟执行事实共用同一本账本，主进程只保留当前窗口所需的内存投影。 */
  localDevice(origin: string): LocalDeviceRegistration | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'device'").get() as { value: string } | undefined
    if (!row) return null
    const device = JSON.parse(row.value) as LocalDeviceRegistration
    if (device.origin !== origin) throw new Error("LEDGER_MISMATCH")
    this.requireIdentity(device.ledgerId)
    const project = this.project(device.projectId)
    return project ? { ...device, shareEnabled: project.shareEnabled, shareVersion: project.shareVersion } : device
  }

  saveLocalDevice(device: LocalDeviceRegistration): void {
    this.transaction(() => {
      const existing = this.localDevice(device.origin)
      if (existing && (["deviceId", "installationId", "ledgerId", "registrationId", "ownerUserId", "secret",
        "workspaceId", "projectId", "projectRoot"] as const).some(key => existing[key] !== device[key])) throw new Error("LEDGER_MISMATCH")
      if (!existing && device.registered) throw new Error("LEDGER_MISMATCH")
      this.requireIdentity(device.ledgerId, !existing)
      const project = this.project(device.projectId)
      if (project && BigInt(device.shareVersion) >= BigInt(project.shareVersion)) {
        this.saveProject({ ...project, shareEnabled: device.shareEnabled, shareVersion: device.shareVersion })
      }
      this.#db.prepare("INSERT INTO meta (key,value) VALUES ('device',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(device))
    })
  }

  /** 多项本机事实共用一次提交；嵌套写由最外层负责回滚。 */
  transaction<T>(work: () => T): T {
    if (this.#inTransaction) return work()
    this.#db.exec("BEGIN IMMEDIATE")
    this.#inTransaction = true
    try {
      const value = work()
      this.#db.exec("COMMIT")
      return value
    } catch (error) {
      this.#db.exec("ROLLBACK")
      throw error
    } finally { this.#inTransaction = false }
  }

  /** 同 executionId 同完整正文视为重复；不同指纹明确冲突，不覆盖首次命令。 */
  recordStart(start: ExecutionStartMessage): "new" | "duplicate" {
    const existing = this.#db.prepare("SELECT start_body_sha256 FROM execution WHERE id = ?").get(start.payload.executionId) as { start_body_sha256: string } | undefined
    if (existing) {
      if (existing.start_body_sha256 !== start.payload.bodySha256) throw new Error("COMMAND_CONFLICT")
      return "duplicate"
    }
    const now = Date.now()
    this.transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM cancel_before_start WHERE json_extract(cancel_json,'$.cancel.payload.startCommandId') = ? OR json_extract(cancel_json,'$.cancel.payload.inputId') = ?").get(start.messageId, start.payload.inputId)) {
        throw new Error("COMMAND_CONFLICT")
      }
      this.#db.prepare("INSERT INTO execution (id,start_json,start_body_sha256,state,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(start.payload.executionId, JSON.stringify(start), start.payload.bodySha256, "stored", now, now)
    })
    return "new"
  }

  execution(id: string): ExecutionRecord | null {
    const query = this.#db.prepare("SELECT * FROM execution WHERE id = ?")
    query.setReadBigInts(true)
    const row = query.get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      start: JSON.parse(String(row.start_json)) as ExecutionStartMessage,
      decision: row.decision_json ? JSON.parse(String(row.decision_json)) as ExecutionStartDecisionMessage : null,
      cancel: row.cancel_json ? JSON.parse(String(row.cancel_json)) as ExecutionCancelMessage : null,
      state: String(row.state) as LocalState,
      nativeSessionId: row.native_session_id == null ? null : String(row.native_session_id),
      lastRunnerSequence: String(row.last_runner_sequence),
      lastCommittedSequence: String(row.last_committed_sequence),
      terminal: row.terminal_json ? JSON.parse(String(row.terminal_json)) as ExecutionTerminalMessage : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  /** 原决定只保存一次；后续重复决定保留首个 messageId。 */
  recordDecision(decision: ExecutionStartDecisionMessage): boolean {
    const row = this.#db.prepare("SELECT decision_json FROM execution WHERE id = ?").get(decision.payload.executionId) as { decision_json: string | null } | undefined
    if (!row) throw new Error("EXECUTION_NOT_FOUND")
    if (row.decision_json) {
      const existing = JSON.parse(row.decision_json) as ExecutionStartDecisionMessage
      if (existing.messageId === decision.messageId && existing.payload.bodySha256 === decision.payload.bodySha256) return false
      throw new Error("COMMAND_CONFLICT")
    }
    this.transaction(() => {
      this.#db.prepare("UPDATE execution SET decision_json = ?, state = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(decision), "decisionStored", Date.now(), decision.payload.executionId)
    })
    return true
  }

  /** 取消先到时一起提交禁启和两条原执行来源，终态可在确认后用于恢复。 */
  saveCancelBeforeStart(record: CancelBeforeStartRecord, received: ExecutionRunnerMessage): void {
    const id = record.cancel.payload.executionId
    this.transaction(() => {
      const target = record.cancel.payload
      if (this.#db.prepare("SELECT 1 FROM execution WHERE json_extract(start_json,'$.messageId') = ? OR json_extract(start_json,'$.payload.inputId') = ?").get(target.startCommandId, target.inputId)) {
        throw new Error("COMMAND_CONFLICT")
      }
      this.#db.prepare("INSERT INTO cancel_before_start (execution_id,cancel_json,created_at) VALUES (?,?,?)")
        .run(id, JSON.stringify(record), Date.now())
      this.enqueue(id, received)
      this.enqueue(id, record.terminal)
    })
  }

  cancelBeforeStart(executionId: string): CancelBeforeStartRecord | null {
    const row = this.#db.prepare("SELECT cancel_json FROM cancel_before_start WHERE execution_id = ?").get(executionId) as { cancel_json: string } | undefined
    if (!row) return null
    const { lateStart: _lateStart, ...record } = JSON.parse(row.cancel_json) as CancelBeforeStartRecord & { lateStart?: ExecutionStartMessage }
    // 已有旧账本若缺确切终态，必须暂停核对，不能视为该执行从未到达。
    if (record.kind !== "cancelBeforeStart" || !record.terminal) throw new Error("LEDGER_MISMATCH")
    return record
  }

  /** 已取消项保留迟到的原文，但恢复仍报告首次持久事实。 */
  recordLateStart(start: ExecutionStartMessage): void {
    this.#db.prepare("UPDATE cancel_before_start SET cancel_json = json_set(cancel_json, '$.lateStart', json(?)) WHERE execution_id = ? AND json_type(cancel_json, '$.lateStart') IS NULL")
      .run(JSON.stringify(start), start.payload.executionId)
  }

  recordCancel(cancel: ExecutionCancelMessage): boolean {
    const row = this.#db.prepare("SELECT cancel_json FROM execution WHERE id = ?").get(cancel.payload.executionId) as { cancel_json: string | null } | undefined
    if (!row) throw new Error("EXECUTION_NOT_FOUND")
    if (row.cancel_json) {
      const existing = JSON.parse(row.cancel_json) as ExecutionCancelMessage
      if (existing.messageId === cancel.messageId && existing.payload.bodySha256 === cancel.payload.bodySha256) return false
      throw new Error("COMMAND_CONFLICT")
    }
    this.transaction(() => {
      this.#db.prepare("UPDATE execution SET cancel_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(cancel), Date.now(), cancel.payload.executionId)
    })
    return true
  }

  update(id: string, state: LocalState, patch: { nativeSessionId?: string | null; terminal?: ExecutionTerminalMessage | null } = {}): void {
    const current = this.execution(id)
    if (!current) throw new Error("EXECUTION_NOT_FOUND")
    this.transaction(() => {
      this.#db.prepare("UPDATE execution SET state = ?, native_session_id = ?, terminal_json = ?, updated_at = ? WHERE id = ?")
        .run(state, patch.nativeSessionId === undefined ? current.nativeSessionId : patch.nativeSessionId,
          patch.terminal === undefined ? (current.terminal ? JSON.stringify(current.terminal) : null) : (patch.terminal ? JSON.stringify(patch.terminal) : null),
          Date.now(), id)
    })
  }

  /**
   * 追加一条来源：显式 runnerSequence 必须严格连续；未带序号的内部消息不占来源位置。
   * 写入 outbox 后才允许网络发送。
   */
  append(executionId: string, message: ExecutionRunnerMessage): string | null {
    const record = this.execution(executionId)
    if (!record) throw new Error("EXECUTION_NOT_FOUND")
    const sequence = message.payload.runnerSequence
    if (BigInt(sequence) !== BigInt(record.lastRunnerSequence) + 1n) throw new Error("SEQUENCE_GAP")
    this.transaction(() => {
      this.enqueue(executionId, message)
      this.#db.prepare("UPDATE execution SET last_runner_sequence = ?, updated_at = ? WHERE id = ?").run(BigInt(sequence), Date.now(), executionId)
    })
    return sequence
  }

  private enqueue(executionId: string, message: ExecutionRunnerMessage): void {
    this.#db.prepare("INSERT INTO outbox (message_id,execution_id,runner_sequence,message_json,created_at) VALUES (?,?,?,?,?)")
      .run(message.messageId, executionId, BigInt(message.payload.runnerSequence), JSON.stringify(message), Date.now())
  }

  /** 已确认但原决定尚未到达时，保留原 accepted 以取回同一个决定。 */
  acknowledge(executionId: string, lastCommitted: string): void {
    const record = this.execution(executionId)
    const early = record ? null : this.cancelBeforeStart(executionId)
    const previous = record?.lastCommittedSequence ?? early?.lastCommittedRunnerSequence
    const last = record?.lastRunnerSequence ?? early?.lastRunnerSequence
    if (previous === undefined || last === undefined || !/^(0|[1-9][0-9]{0,18})$/.test(lastCommitted)) throw new Error("ACK_CONFLICT")
    const value = BigInt(lastCommitted)
    if (value > BigInt(last)) throw new Error("ACK_CONFLICT")
    if (value < BigInt(previous)) return
    this.transaction(() => {
      const keepAccepted = record !== null && record.decision === null
      this.#db.prepare("DELETE FROM outbox WHERE execution_id = ? AND runner_sequence <= ? AND (? = 0 OR runner_sequence <> 1)")
        .run(executionId, value, Number(keepAccepted))
      if (record) this.#db.prepare("UPDATE execution SET last_committed_sequence = ?, updated_at = ? WHERE id = ?").run(value, Date.now(), executionId)
      if (early) this.#db.prepare("UPDATE cancel_before_start SET cancel_json = json_set(cancel_json, '$.lastCommittedRunnerSequence', ?) WHERE execution_id = ?")
        .run(lastCommitted, executionId)
    })
  }

  /** 本地才是受理/终态的证明，云端恢复不得用空清单替代账本。 */
  recoveryRecords(): ResumeRecord[] {
    const executionRows = this.#db.prepare("SELECT id FROM execution").all() as { id: string }[]
    const cancelledRows = this.#db.prepare("SELECT execution_id FROM cancel_before_start").all() as { execution_id: string }[]
    return [...executionRows.map(({ id }) => {
      const row = this.execution(id)!
      const localState: LocalExecutionRecord["localState"] = row.state === "terminalStored" ? "terminalPending" : row.state === "decisionStored" ? "notInvoked"
        : row.state === "stored" ? "unknown" : row.state
      return { kind: "execution" as const, start: row.start, decision: row.decision, cancel: row.cancel, localState,
        lastRunnerSequence: row.lastRunnerSequence, lastCommittedRunnerSequence: row.lastCommittedSequence,
        nativeSessionId: row.nativeSessionId, terminal: row.terminal }
    }), ...cancelledRows.map(row => this.cancelBeforeStart(row.execution_id)!)]
  }

  /** 进程重启不能证明原调用或其遗留进程已经停止，保留目录占用。 */
  markInterruptedExecutions(): void {
    this.#db.exec("UPDATE execution SET state = 'unknown' WHERE state IN ('invoking', 'running')")
  }

  outstanding(executionId: string): OutboxItem[] {
    const query = this.#db.prepare("SELECT message_id,execution_id,runner_sequence,message_json FROM outbox WHERE execution_id = ? ORDER BY COALESCE(runner_sequence, 0), created_at")
    query.setReadBigInts(true)
    const rows = query.all(executionId) as Record<string, unknown>[]
    return rows.map(row => ({
      messageId: String(row.message_id), executionId: String(row.execution_id),
      sequence: row.runner_sequence == null ? null : String(row.runner_sequence),
      message: JSON.parse(String(row.message_json)) as ExecutionRunnerMessage,
    }))
  }

  allOutstanding(): OutboxItem[] {
    const query = this.#db.prepare("SELECT message_id,execution_id,runner_sequence,message_json FROM outbox ORDER BY execution_id, runner_sequence")
    query.setReadBigInts(true)
    const rows = query.all() as Record<string, unknown>[]
    return rows.map(row => ({
      messageId: String(row.message_id), executionId: String(row.execution_id),
      sequence: row.runner_sequence == null ? null : String(row.runner_sequence),
      message: JSON.parse(String(row.message_json)) as ExecutionRunnerMessage,
    }))
  }

  /** 未终态执行：重启后只按原记录恢复/补传，不自动重跑。 */
  unresolved(): ExecutionRecord[] {
    const rows = this.#db.prepare("SELECT id FROM execution WHERE state NOT IN ('terminalStored') ORDER BY created_at").all() as { id: string }[]
    return rows.map(row => this.execution(row.id)).filter((record): record is ExecutionRecord => record !== null)
  }

  saveProject(project: { id: string; rootRef: string; rootPath: string; name: string; shareEnabled: boolean; shareVersion: string }): void {
    const now = Date.now()
    this.transaction(() => {
      this.#db.prepare("INSERT INTO project (id,root_ref,root_path,name,share_enabled,share_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root_ref = excluded.root_ref, root_path = excluded.root_path, name = excluded.name, share_enabled = excluded.share_enabled, share_version = excluded.share_version, updated_at = excluded.updated_at")
        .run(project.id, project.rootRef, project.rootPath, project.name, project.shareEnabled ? 1 : 0, BigInt(project.shareVersion), now, now)
    })
  }

  project(id: string): { id: string; rootRef: string; rootPath: string; name: string; shareEnabled: boolean; shareVersion: string } | null {
    const query = this.#db.prepare("SELECT * FROM project WHERE id = ?")
    query.setReadBigInts(true)
    const row = query.get(id) as Record<string, unknown> | undefined
    return row ? { id: String(row.id), rootRef: String(row.root_ref), rootPath: String(row.root_path), name: String(row.name), shareEnabled: Number(row.share_enabled) === 1, shareVersion: String(row.share_version) } : null
  }

  projectIds(): string[] {
    return (this.#db.prepare("SELECT id FROM project").all() as { id: string }[]).map(row => row.id)
  }

  /** 根占用跨重启保留；只有确认真实未调用/已结束时才释放。 */
  occupy(rootRef: string, executionId: string): boolean {
    return this.transaction(() => {
      if (this.occupied(rootRef) !== null) return false
      this.#db.prepare("INSERT INTO occupancy (root_ref,execution_id,created_at) VALUES (?,?,?)").run(rootRef, executionId, Date.now())
      return true
    })
  }

  release(rootRef: string, executionId: string): void {
    this.transaction(() => {
      this.#db.prepare("DELETE FROM occupancy WHERE root_ref = ? AND execution_id = ?").run(rootRef, executionId)
    })
  }

  occupied(rootRef: string): string | null {
    const row = this.#db.prepare("SELECT execution_id FROM occupancy WHERE root_ref = ?").get(rootRef) as { execution_id: string } | undefined
    return row ? row.execution_id : null
  }

  vacuumCheckpoint(): void { this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)") }
}
