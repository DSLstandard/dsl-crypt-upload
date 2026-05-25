import Database from "better-sqlite3"
import { sql } from "../utils/sqlite.js"

/**
 * Application database: seeding files and upload session audit log.
 *
 * Uses better-sqlite3 (synchronous) — safe to call from the worker loop
 * since SQLite writes are fast and the worker processes one message at a time.
 */
export class Db {
  private constructor(private readonly db: Database.Database) {
  }

  /** Open a database at the given path and run schema init. */
  static create(dbPath: string): Db {
    const db = new Database(dbPath)
    db.pragma("journal_mode = WAL")
    const instance = new Db(db)
    instance.migrate()
    return instance
  }

  /* ── Schema init (idempotent) ──────────────────────────────────────── */

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seeding_files (
        id TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        expire_ts REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_seeding_files_expire_ts ON seeding_files (expire_ts);

      CREATE TABLE IF NOT EXISTS upload_session_log (
        id TEXT PRIMARY KEY,
        begin_ts REAL NOT NULL,
        size_declared INTEGER NOT NULL,
        expire_ts REAL NOT NULL,
        terminated_ts REAL,
        reason TEXT
      );
    `)
  }

  /* ── Seeding files ──────────────────────────────────────────────── */

  /** Insert a new seeding file record. */
  insertSeedingFile(id: string, size: number, expireTs: number): void {
    sql(
      this.db,
      "INSERT INTO seeding_files (id, size, expire_ts) VALUES (:id, :size, :expireTs)",
      { id, size, expireTs }
    ).none()
  }

  /** Soft-delete a seeding file (mark as deleted). */
  softDeleteSeedingFile(id: string): void {
    sql(this.db, "UPDATE seeding_files SET is_deleted = 1 WHERE id = :id", { id }).none()
  }

  /** Get all non-deleted, unexpired seeding files. */
  getActiveSeedingFiles(nowTs: number): { id: string; size: number; expireTs: number }[] {
    return sql(
      this.db,
      "SELECT id, size, expire_ts FROM seeding_files WHERE is_deleted = 0 AND expire_ts > :nowTs",
      { nowTs }
    ).many().map((r) => ({
      id: r.getString("id"),
      size: r.getInt("size"),
      expireTs: r.getReal("expire_ts"),
    }))
  }

  /** Get a specific seeding file record (regardless of deleted/expired). */
  getSeedingFile(id: string): {
    id: string
    size: number
    isDeleted: boolean
    expireTs: number
  } | null {
    const row = sql(this.db, "SELECT id, size, is_deleted, expire_ts FROM seeding_files WHERE id = :id", { id }).maybe()
    if (!row) return null
    return {
      id: row.getString("id"),
      size: row.getInt("size"),
      isDeleted: row.getInt("is_deleted") !== 0,
      expireTs: row.getReal("expire_ts"),
    }
  }

  /** Sum of sizes of all non-deleted, unexpired seeding files. */
  sumActiveSeedingSizes(nowTs: number): number {
    const row = sql(
      this.db,
      "SELECT COALESCE(SUM(size), 0) AS total FROM seeding_files WHERE is_deleted = 0 AND expire_ts > :nowTs",
      { nowTs }
    ).one()
    return row.getInt("total")
  }

  /** Soft-delete all expired seeding files and return their IDs (for disk cleanup). */
  expireOldSeedingFiles(nowTs: number): { id: string; size: number }[] {
    const rows = sql(
      this.db,
      "SELECT id, size FROM seeding_files WHERE is_deleted = 0 AND expire_ts <= :nowTs",
      { nowTs }
    ).many().map((r) => ({ id: r.getString("id"), size: r.getInt("size") }))

    for (const { id } of rows) {
      sql(this.db, "UPDATE seeding_files SET is_deleted = 1 WHERE id = :id", { id }).none()
    }

    return rows
  }

  /* ── Upload session audit log ───────────────────────────────────── */

  /** Record the start of an upload session. */
  insertUploadSession(id: string, beginTs: number, sizeDeclared: number, expireTs: number): void {
    sql(
      this.db,
      "INSERT INTO upload_session_log (id, begin_ts, size_declared, expire_ts) VALUES (:id, :beginTs, :sizeDeclared, :expireTs)",
      { id, beginTs, sizeDeclared, expireTs }
    ).none()
  }

  /** Record the termination of an upload session. */
  terminateUploadSession(id: string, terminatedTs: number, reason: string): void {
    sql(
      this.db,
      "UPDATE upload_session_log SET terminated_ts = :terminatedTs, reason = :reason WHERE id = :id",
      { terminatedTs, reason, id }
    ).none()
  }

  /** Mark all sessions without a terminated_ts as terminated (e.g. on server restart). */
  terminateAllActiveSessions(terminatedTs: number, reason: string): void {
    sql(
      this.db,
      "UPDATE upload_session_log SET terminated_ts = :terminatedTs, reason = :reason WHERE terminated_ts IS NULL",
      { terminatedTs, reason }
    ).none()
  }

  /* ── Lifecycle ──────────────────────────────────────────────────── */

  close(): void {
    this.db.close()
  }
}
