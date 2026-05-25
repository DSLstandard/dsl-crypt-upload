import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { FileStoreWorkerAPI, type FileStoreBootupParams } from "../src/feats/file-store/worker-api.js"
import { Db } from "../src/feats/file-store/db.js"
import { LogAction } from "../src/feats/utils/colog.js"
import { Option } from "effect"

/* ── Helpers ────────────────────────────────────────────────────────── */

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fsw-test-"))
}

function rmdirAll(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

const silentLogger = LogAction.createBasicLogAction("Test")

interface TestContext {
  params: FileStoreBootupParams
  db: Db

  /* Control the clock for testing expiry. */
  advance: (seconds: number) => void

  /* Get current timestamp in seconds */
  now: () => number
}

/** Build params with temp dir, fresh DB, and a controllable clock. */
function makeContext(opts: {
  dir: string
  maxAllocSize?: number
  maxFileSize?: number
  minExpireDuration?: number
  maxExpireDuration?: number
  now?: number
}): TestContext {
  const dbPath = path.join(opts.dir, "test.db")
  const db = Db.create(dbPath)

  let currentTime = opts.now ?? 1_000_000_000

  const advance = (seconds: number): void => {
    currentTime += seconds
  }
  const nowFn = (): number => currentTime

  return {
    db,
    advance,
    now: nowFn,
    params: {
      logger: silentLogger,
      maxAllocSize: opts.maxAllocSize ?? 100_000,
      maxFileSize: opts.maxFileSize ?? 10_000,
      minExpireDuration: opts.minExpireDuration ?? 1,
      maxExpireDuration: opts.maxExpireDuration ?? 86400,
      filesDir: opts.dir,
      db,
      getCurrentTimestamp: nowFn,
    },
  }
}

/** Assert an Option is Some and return its value, narrowing the type. */
function assertSome<T>(opt: Option.Option<T>): T {
  if (Option.isNone(opt)) throw new Error("Expected Some, got None")
  return opt.value
}

/** Feed chunk of given byte value and length to a write call. */
function makeChunk(value: number, length: number): Uint8Array {
  const buf = new Uint8Array(length)
  buf.fill(value)
  return buf
}

/* ── Tests ──────────────────────────────────────────────────────────── */

describe("FileStoreWorkerAPI", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    rmdirAll(dir)
  })

  /* ── Happy path ────────────────────────────────────────────────── */

  it("begin → write → commit → query succeeds", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 100 bytes, expiry 1 hour out — safe window for any test order.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 100, expireInSeconds: 3600 }))

    // Two chunks (40 + 60 = 100) with distinct fill values to verify ordering.
    const ok1 = await store.requestUploadWriteChunk(sessId, makeChunk(0xAB, 40))
    expect(ok1).toBe(true)

    const ok2 = await store.requestUploadWriteChunk(sessId, makeChunk(0xCD, 60))
    expect(ok2).toBe(true)

    const fileId = assertSome(await store.requestUploadCommit(sessId))

    const info = assertSome(await store.querySeedingFileInfo(fileId))
    expect(info.fileSize).toBe(100)

    const content = await fs.promises.readFile(store.getSeedingFilePath(fileId))
    expect(content.length).toBe(100)
    expect(content[0]).toBe(0xAB)
    expect(content[99]).toBe(0xCD)

    await store.shutdown()
  })

  /* ── Empty file ────────────────────────────────────────────────── */

  it("declaredSize=0 is rejected", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    const sessId = await store.requestUploadBegin({ declaredSize: 0, expireInSeconds: 3600 })
    expect(Option.isNone(sessId)).toBe(true)

    await store.shutdown()
  })

  /* ── Terminate ─────────────────────────────────────────────────── */

  it("terminate cleans up the session", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // Declare 100, write 50 — deliberately partial to test mid-session abort.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 100, expireInSeconds: 3600 }))
    await store.requestUploadWriteChunk(sessId, makeChunk(0, 50))

    const ok = await store.requestUploadTerminate(sessId)
    expect(ok).toBe(true)

    /* Second terminate should return false. */
    const ok2 = await store.requestUploadTerminate(sessId)
    expect(ok2).toBe(false)

    /* Uploading file should be gone. */
    const uploadingPath = path.join(dir, "uploading", `${sessId}.dat`)
    await expect(fs.promises.access(uploadingPath)).rejects.toThrow()

    await store.shutdown()
  })

  /* ── Size exceeded ─────────────────────────────────────────────── */

  it("write exceeding declared size is rejected and terminates session", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 51 bytes > declared 50 — 1 over to test the boundary.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 50, expireInSeconds: 3600 }))

    const ok = await store.requestUploadWriteChunk(sessId, makeChunk(0, 51))
    expect(ok).toBe(false)

    /* Session is dead — subsequent writes fail. */
    const ok2 = await store.requestUploadWriteChunk(sessId, makeChunk(0, 10))
    expect(ok2).toBe(false)

    await store.shutdown()
  })

  /* ── Expired session check (lazy) ───────────────────────────────── */

  it("write to expired session is rejected", async () => {
    const { params, advance } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 1 second expiry, then advance past it.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 50, expireInSeconds: 1 }))

    // ADVANCE THE CLOCK PAST EXPIRY BEFORE WRITE
    advance(2)

    const ok = await store.requestUploadWriteChunk(sessId, makeChunk(0, 10))
    expect(ok).toBe(false)

    await store.shutdown()
  })

  /* ── Commit without write ──────────────────────────────────────── */

  it("commit with nbytesWritten < declaredSize is rejected", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 40 bytes written out of 100 declared — tests under-write rejection.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 100, expireInSeconds: 3600 }))

    /* Write only 40 of 100 bytes. */
    await store.requestUploadWriteChunk(sessId, makeChunk(0, 40))

    const fileId = await store.requestUploadCommit(sessId)
    expect(Option.isNone(fileId)).toBe(true)

    await store.shutdown()
  })

  /* ── Commit on dead session ────────────────────────────────────── */

  it("commit on terminated session returns None", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 10 bytes — small size is sufficient to test dead-session rejection.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 3600 }))

    await store.requestUploadTerminate(sessId)
    const fileId = await store.requestUploadCommit(sessId)
    expect(Option.isNone(fileId)).toBe(true)

    await store.shutdown()
  })

  /* ── Double commit ─────────────────────────────────────────────── */

  it("double commit returns None on second attempt", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 3600 }))
    await store.requestUploadWriteChunk(sessId, makeChunk(0, 10))

    const fileId1 = await store.requestUploadCommit(sessId)
    expect(Option.isSome(fileId1)).toBe(true)

    const fileId2 = await store.requestUploadCommit(sessId)
    expect(Option.isNone(fileId2)).toBe(true)

    await store.shutdown()
  })

  /* ── Write after commit ────────────────────────────────────────── */

  it("write after commit is rejected", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 3600 }))
    await store.requestUploadWriteChunk(sessId, makeChunk(0, 10))
    await store.requestUploadCommit(sessId)

    const ok = await store.requestUploadWriteChunk(sessId, makeChunk(0, 5))
    expect(ok).toBe(false)

    await store.shutdown()
  })

  /* ── Max file size limit ───────────────────────────────────────── */

  it("begin with declaredSize > maxFileSize is rejected", async () => {
    const { params } = makeContext({ dir, maxFileSize: 100 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 101 > maxFileSize=100 — 1 over to test the boundary.
    const sessId = await store.requestUploadBegin({ declaredSize: 101, expireInSeconds: 3600 })
    expect(Option.isNone(sessId)).toBe(true)

    await store.shutdown()
  })

  /* ── Max alloc size limit ──────────────────────────────────────── */

  it("begin when allocSize + declaredSize > maxAllocSize is rejected", async () => {
    const { params } = makeContext({ dir, maxAllocSize: 100 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 60 fits within maxAllocSize=100, leaving 40.
    const s1 = await store.requestUploadBegin({ declaredSize: 60, expireInSeconds: 3600 })
    expect(Option.isSome(s1)).toBe(true)

    // 50 exceeds remaining capacity of 40 → rejected.
    const s2 = await store.requestUploadBegin({ declaredSize: 50, expireInSeconds: 3600 })
    expect(Option.isNone(s2)).toBe(true)

    await store.shutdown()
  })

  /* ── Max expire duration limit ──────────────────────────────── */

  it("begin with expireInSeconds within maxExpireDuration is accepted", async () => {
    const { params } = makeContext({ dir, maxExpireDuration: 60 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 30s from now is within the 60s limit.
    const s1 = await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 30 })
    expect(Option.isSome(s1)).toBe(true)

    await store.shutdown()
  })

  it("begin with expireInSeconds exceeding maxExpireDuration is rejected", async () => {
    const { params } = makeContext({ dir, maxExpireDuration: 60 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 90s from now exceeds the 60s limit.
    const s1 = await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 90 })
    expect(Option.isNone(s1)).toBe(true)

    await store.shutdown()
  })

  it("begin with expireInSeconds exactly at maxExpireDuration boundary is accepted", async () => {
    const { params } = makeContext({ dir, maxExpireDuration: 60 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // Exactly 60s from now = at the boundary, should be accepted.
    const s1 = await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 60 })
    expect(Option.isSome(s1)).toBe(true)

    await store.shutdown()
  })

  /* ── Min expire duration limit ──────────────────────────────── */

  it("begin with expireInSeconds below minExpireDuration is rejected", async () => {
    const { params } = makeContext({ dir, minExpireDuration: 30 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 10s below the 30s minimum.
    const s1 = await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 10 })
    expect(Option.isNone(s1)).toBe(true)

    await store.shutdown()
  })

  it("begin with expireInSeconds at minExpireDuration boundary is accepted", async () => {
    const { params } = makeContext({ dir, minExpireDuration: 30 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // Exactly 30s = at the minimum boundary.
    const s1 = await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 30 })
    expect(Option.isSome(s1)).toBe(true)

    await store.shutdown()
  })

  it("begin with expireInSeconds above minExpireDuration is accepted", async () => {
    const { params } = makeContext({ dir, minExpireDuration: 30 })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 60s well above the 30s minimum.
    const s1 = await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 60 })
    expect(Option.isSome(s1)).toBe(true)

    await store.shutdown()
  })

  /* ── Extreme / edge case numeric values ────────────────────────────────── */

  it("begin with declaredSize at Number.MAX_SAFE_INTEGER is accepted", async () => {
    const { params } = makeContext({
      dir,
      maxFileSize: Number.MAX_SAFE_INTEGER,
      maxAllocSize: Number.MAX_SAFE_INTEGER,
    })
    const store = await FileStoreWorkerAPI.bootup(params)

    const sessId = await store.requestUploadBegin({
      declaredSize: Number.MAX_SAFE_INTEGER,
      expireInSeconds: 3600,
    })
    expect(Option.isSome(sessId)).toBe(true)

    await store.shutdown()
  })

  it("DB round-trips seeding file size at Number.MAX_SAFE_INTEGER", async () => {
    const { db } = makeContext({ dir })

    const id = "extreme-size-test"
    const size = Number.MAX_SAFE_INTEGER
    const expireTs = Date.now() / 1000 + 3600

    db.insertSeedingFile(id, size, expireTs)

    const retrieved = db.getSeedingFile(id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.size).toBe(size)
    expect(retrieved!.isDeleted).toBe(false)

    db.softDeleteSeedingFile(id)
    db.close()
  })

  it("DB round-trips seeding file size at 9,007,199,254,740,991 (MAX_SAFE_INTEGER)", async () => {
    const { db } = makeContext({ dir })

    const id = "max-safe-int-test"
    const size = 9_007_199_254_740_991
    const expireTs = Date.now() / 1000 + 3600

    db.insertSeedingFile(id, size, expireTs)

    const retrieved = db.getSeedingFile(id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.size).toBe(size)
    expect(retrieved!.size.toString()).toBe(size.toString())

    db.softDeleteSeedingFile(id)
    db.close()
  })

  it("DB round-trips seeding file expire_ts at extreme future values", async () => {
    const { db } = makeContext({ dir })

    const id = "extreme-expire-test"
    const size = 100
    // A timestamp far in the future — year ~583 billion.
    const extremeTs = 9_000_000_000_000_000_000

    db.insertSeedingFile(id, size, extremeTs)

    const retrieved = db.getSeedingFile(id)
    expect(retrieved).not.toBeNull()

    // expire_ts is stored as SQLite REAL (IEEE double), which loses precision
    // beyond 2^53. We expect the value to be close but may not be exact.
    // SQLite REAL can represent integers up to 2^53 exactly, beyond that
    // precision is limited by the 52-bit mantissa.
    const diff = Math.abs(retrieved!.expireTs - extremeTs)
    // For 9e18, IEEE double precision is ~1024, so diff should be < 2048.
    expect(diff).toBeLessThan(2048)

    db.softDeleteSeedingFile(id)
    db.close()
  })

  /* ── Multiple concurrent sessions ──────────────────────────────── */

  it("two interleaved sessions succeed independently", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // Both 50 — same size but distinct fill bytes to prove isolation.
    const s1 = assertSome(await store.requestUploadBegin({ declaredSize: 50, expireInSeconds: 3600 }))
    const s2 = assertSome(await store.requestUploadBegin({ declaredSize: 50, expireInSeconds: 3600 }))

    const ok1 = await store.requestUploadWriteChunk(s1, makeChunk(0xAA, 50))
    const ok2 = await store.requestUploadWriteChunk(s2, makeChunk(0xBB, 50))
    expect(ok1).toBe(true)
    expect(ok2).toBe(true)

    const f1 = assertSome(await store.requestUploadCommit(s1))
    const f2 = assertSome(await store.requestUploadCommit(s2))

    /* Verify both files have correct content. */
    const p1 = store.getSeedingFilePath(f1)
    const p2 = store.getSeedingFilePath(f2)
    const c1 = await fs.promises.readFile(p1)
    const c2 = await fs.promises.readFile(p2)
    expect(c1[0]).toBe(0xAA)
    expect(c2[0]).toBe(0xBB)

    await store.shutdown()
  })

  /* ── Query non-existent / expired file ─────────────────────────── */

  it("querySeedingFileInfo returns None for unknown fileId", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    const info = await store.querySeedingFileInfo("nonexistent")
    expect(Option.isNone(info)).toBe(true)

    await store.shutdown()
  })

  it("querySeedingFileInfo returns None for expired file", async () => {
    const { params, now, advance } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    /* Create and commit a file that expires 1 second from now. */
    const s = assertSome(await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 1 }))
    await store.requestUploadWriteChunk(s, makeChunk(0, 10))
    const f = assertSome(await store.requestUploadCommit(s))

    /* Advance past expiry. */
    advance(2)

    const info = await store.querySeedingFileInfo(f)
    expect(Option.isNone(info)).toBe(true)

    await store.shutdown()
  })

  /* ── Cleanup expired sessions ──────────────────────────────────── */

  it("cleanupExpired terminates expired sessions", async () => {
    const { params, now, advance } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // Session expires in 5 seconds.
    const s1 = assertSome(await store.requestUploadBegin({ declaredSize: 50, expireInSeconds: 5 }))

    // Advance 10 seconds to push well past expiry.
    advance(10)

    await store.cleanupExpired()

    /* Write should fail since session was cleaned up. */
    const ok = await store.requestUploadWriteChunk(s1, makeChunk(0, 10))
    expect(ok).toBe(false)

    await store.shutdown()
  })

  /* ── Cleanup expired seeding files ─────────────────────────────── */

  it("cleanupExpired removes expired seeding files from disk", async () => {
    const { params, now, advance } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // Create and commit a small file that expires in 5 seconds.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 10, expireInSeconds: 5 }))
    await store.requestUploadWriteChunk(sessId, makeChunk(0, 10))
    const fileId = assertSome(await store.requestUploadCommit(sessId))

    const filePath = store.getSeedingFilePath(fileId)
    expect(fs.existsSync(filePath)).toBe(true)

    // Advance 10 seconds past the 5-second expiry and trigger cleanup.
    advance(10)
    await store.cleanupExpired()

    expect(fs.existsSync(filePath)).toBe(false)

    await store.shutdown()
  })

  /* ── Persistence: commit → restart → query ────────────────────── */

  it("seeding files survive worker restart", async () => {
    const { params, db, now } = makeContext({ dir })
    let store = await FileStoreWorkerAPI.bootup(params)

    // Standard size, 1 hour expiry — file should survive across restarts.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 50, expireInSeconds: 3600 }))
    await store.requestUploadWriteChunk(sessId, makeChunk(0x42, 50))
    const fileId = assertSome(await store.requestUploadCommit(sessId))

    await store.shutdown()

    /* Recreate with the same DB and dir. */
    const params2: FileStoreBootupParams = {
      logger: silentLogger,
      maxAllocSize: 100_000,
      maxFileSize: 10_000,
      minExpireDuration: 1,
      maxExpireDuration: 86400,
      filesDir: dir,
      db,
      getCurrentTimestamp: now,
    }
    store = await FileStoreWorkerAPI.bootup(params2)

    const info = assertSome(await store.querySeedingFileInfo(fileId))
    expect(info.fileSize).toBe(50)

    /* File content should be intact. */
    const content = await fs.promises.readFile(info.filePath)
    expect(content[0]).toBe(0x42)
    expect(content.length).toBe(50)

    await store.shutdown()
  })

  /* ── Startup cleanup: leftover uploading files ─────────────────── */

  it("leftover uploading files are deleted on startup", async () => {
    const { params, db } = makeContext({ dir })

    /* Write a stale uploading file directly. */
    const staleDir = path.join(dir, "uploading")
    const stalePath = path.join(staleDir, "stale.dat")
    await fs.promises.mkdir(staleDir, { recursive: true })
    await fs.promises.writeFile(stalePath, "leftover")

    const store = await FileStoreWorkerAPI.bootup(params)
    await store.shutdown()

    /* Stale file should be gone. */
    expect(fs.existsSync(stalePath)).toBe(false)
    db.close()
  })

  /* ── Expired session in db at startup ──────────────────────────── */

  it("active sessions in DB are terminated on startup", async () => {
    const { params, db, now } = makeContext({ dir })

    /* Directly insert an active session into DB (simulating crash). */
    db.insertUploadSession("crash-session-1", now(), 100, now() + 3600)

    /* Startup should run terminateAllActiveSessions without crashing. */
    const store = await FileStoreWorkerAPI.bootup(params)
    await store.shutdown()
    db.close()
  })

  /* ── Chunk exact at declared size boundary ─────────────────────── */

  it("writing exactly declaredSize then commit succeeds", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 64 bytes — single chunk that exactly hits the declared size.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 64, expireInSeconds: 3600 }))

    const ok = await store.requestUploadWriteChunk(sessId, makeChunk(0xFF, 64))
    expect(ok).toBe(true)

    const fileId = assertSome(await store.requestUploadCommit(sessId))

    const content = await fs.promises.readFile(store.getSeedingFilePath(fileId))
    expect(content.length).toBe(64)
    expect(content[63]).toBe(0xFF)

    await store.shutdown()
  })

  /* ── Multiple sequential writes summing to declaredSize ────────── */

  it("multiple small writes summing to declaredSize succeed", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    // 10 chunks of 10 bytes each = 100 total, each chunk has a unique fill byte.
    const sessId = assertSome(await store.requestUploadBegin({ declaredSize: 100, expireInSeconds: 3600 }))

    for (let i = 0; i < 10; i++) {
      const ok = await store.requestUploadWriteChunk(sessId, makeChunk(i, 10))
      expect(ok).toBe(true)
    }

    const fileId = assertSome(await store.requestUploadCommit(sessId))

    const content = await fs.promises.readFile(store.getSeedingFilePath(fileId))
    expect(content.length).toBe(100)
    expect(content[0]).toBe(0)
    expect(content[99]).toBe(9)

    await store.shutdown()
  })

  /* ── Bogus session ID ──────────────────────────────────────────── */

  it("write to bogus sessId returns false", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    const ok = await store.requestUploadWriteChunk("bogus-session", makeChunk(0, 10))
    expect(ok).toBe(false)

    await store.shutdown()
  })

  it("commit bogus sessId returns None", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    const fileId = await store.requestUploadCommit("bogus-session")
    expect(Option.isNone(fileId)).toBe(true)

    await store.shutdown()
  })

  it("terminate bogus sessId returns false", async () => {
    const { params } = makeContext({ dir })
    const store = await FileStoreWorkerAPI.bootup(params)

    const ok = await store.requestUploadTerminate("bogus-session")
    expect(ok).toBe(false)

    await store.shutdown()
  })
})
