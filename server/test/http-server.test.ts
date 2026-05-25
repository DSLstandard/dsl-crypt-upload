import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { LogAction } from "../src/feats/utils/colog.js"
import { FileStoreWorkerAPI } from "../src/feats/file-store/worker-api.js"
import { Db } from "../src/feats/file-store/db.js"
import { createHonoServer } from "../src/feats/server-core/create-hono.js"

/* ── Helpers ────────────────────────────────────────────────────────── */

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "http-test-"))
}

function rmdirAll(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

const silentLogger = LogAction.createBasicLogAction("Test")

/** A duration (seconds) far enough in the future to avoid expiry during tests. */
const FUTURE_DURATION = 3600

interface TestCtx {
  app: Hono
  store: FileStoreWorkerAPI
  db: Db
  dir: string
}

async function setupApp(): Promise<TestCtx> {
  const dir = makeTempDir()
  const dbPath = path.join(dir, "test.db")
  const filesDir = path.join(dir, "files")
  const db = Db.create(dbPath)

  const store = await FileStoreWorkerAPI.bootup({
    logger: silentLogger,
    maxAllocSize: 100_000_000,
    maxFileSize: 10_000_000,
    minExpireDuration: 1,
    maxExpireDuration: 86400,
    filesDir,
    db,
  })

  const app = new Hono()
  createHonoServer(app, store, silentLogger)

  return { app, store, db, dir }
}

async function teardown(ctx: TestCtx): Promise<void> {
  await ctx.store.shutdown()
  ctx.db.close()
  rmdirAll(ctx.dir)
}

/* ── Tests ──────────────────────────────────────────────────────────── */

describe("HTTP server tests", () => {
  let ctx: TestCtx

  beforeEach(async () => {
    ctx = await setupApp()
  })

  afterEach(async () => {
    await teardown(ctx)
  })

  /* ── /api/upload/begin ──────────────────────────────────────────── */

  describe("POST /api/upload/begin", () => {
    it("rejects negative declaredSize", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: -1, expireInSeconds: FUTURE_DURATION }),
      })
      expect(res.status).toBe(400)
    })

    it("rejects zero declaredSize", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 0, expireInSeconds: FUTURE_DURATION }),
      })
      expect(res.status).toBe(400)
    })

    it("rejects non-integer declaredSize", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: "abc", expireInSeconds: FUTURE_DURATION }),
      })
      expect(res.status).toBe(400)
    })

    it("rejects missing fields", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it("rejects non-JSON body", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      })
      expect(res.status).toBe(400)
    })

    it("accepts expireInSeconds of 1 (short but valid)", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 100, expireInSeconds: 1 }),
      })
      // 1-second expiry is a valid positive duration — accepted.
      expect(res.status).toBe(200)
    })

    it("rejects floating-point declaredSize", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 1.5, expireInSeconds: FUTURE_DURATION }),
      })
      expect(res.status).toBe(400)
    })

    it("rejects declaredSize beyond Number.MAX_SAFE_INTEGER via lossy JSON parse", async () => {
      // JSON.parse can represent integers up to 2^53 exactly. Beyond that,
      // precision is lost. Send a value that exceeds maxFileSize.
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 9_999_999_999_999_999, expireInSeconds: FUTURE_DURATION }),
      })
      // 9,999,999,999,999,999 exceeds maxFileSize (10,000,000) so worker rejects it.
      expect(res.status).toBe(400)
    })

    it("rejects negative expireInSeconds", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 100, expireInSeconds: -1 }),
      })
      // Schema.Int.pipe(Schema.positive()) rejects negative values.
      expect(res.status).toBe(400)
    })

    it("rejects zero expireInSeconds", async () => {
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 100, expireInSeconds: 0 }),
      })
      // Schema.Int.pipe(Schema.positive()) rejects zero.
      expect(res.status).toBe(400)
    })

    it("rejects declaredSize at 1e20 (far beyond safe integer range)", async () => {
      // JSON.parse("1e20") → 100000000000000000000 which JS cannot represent
      // exactly. But the schema validator Schema.Int will reject it because
      // it's not an integer in JSON terms (uses scientific notation).
      const body = JSON.stringify({ declaredSize: 1e20, expireInSeconds: FUTURE_DURATION })
      const res = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
      expect(res.status).toBe(400)
    })
  })

  /* ── /api/upload/write ───────────────────────────────────────────── */

  describe("POST /api/upload/write", () => {
    it("rejects empty sessId", async () => {
      const res = await ctx.app.request("/api/upload/write?sessId=", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([Buffer.alloc(10)]),
      })
      expect(res.status).toBe(400)
    })

    it("rejects missing sessId", async () => {
      const res = await ctx.app.request("/api/upload/write", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([Buffer.alloc(10)]),
      })
      expect(res.status).toBe(400)
    })

    it("rejects invalid sessId characters (path traversal attempt)", async () => {
      const res = await ctx.app.request("/api/upload/write?sessId=../../etc/passwd", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([Buffer.alloc(10)]),
      })
      // The alnum schema rejects non-alphanumeric characters
      expect(res.status).toBe(400)
    })

    it("rejects non-existent sessId", async () => {
      const res = await ctx.app.request("/api/upload/write?sessId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([Buffer.alloc(10)]),
      })
      expect(res.status).toBe(400)
    })
  })

  /* ── /api/upload/commit ──────────────────────────────────────────── */

  describe("POST /api/upload/commit", () => {
    it("rejects missing sessId", async () => {
      const res = await ctx.app.request("/api/upload/commit", { method: "POST" })
      expect(res.status).toBe(400)
    })

    it("rejects empty sessId", async () => {
      const res = await ctx.app.request("/api/upload/commit?sessId=", { method: "POST" })
      expect(res.status).toBe(400)
    })

    it("rejects non-existent sessId", async () => {
      const res = await ctx.app.request("/api/upload/commit?sessId=nonexistent123", { method: "POST" })
      expect(res.status).toBe(400)
    })

    it("rejects path-traversal sessId", async () => {
      const res = await ctx.app.request("/api/upload/commit?sessId=../../../etc/passwd", { method: "POST" })
      expect(res.status).toBe(400)
    })
  })

  /* ── /api/upload/terminate ───────────────────────────────────────── */

  describe("POST /api/upload/terminate", () => {
    it("rejects missing sessId", async () => {
      const res = await ctx.app.request("/api/upload/terminate", { method: "POST" })
      expect(res.status).toBe(400)
    })

    it("rejects non-existent sessId", async () => {
      const res = await ctx.app.request("/api/upload/terminate?sessId=nonexistent", { method: "POST" })
      expect(res.status).toBe(400)
    })
  })

  /* ── /api/upload/oneshot ───────────────────────────────────────────
   *
   * NOTE: Content-Length validation can't be tested via app.request()
   * because the Fetch API's Request constructor strips Content-Length
   * (it's a forbidden header). Real HTTP requests always include it.
   * Content-Length validation is tested at the worker API level in
   * file-store-worker.test.ts.
   */

  describe("POST /api/upload/oneshot", () => {
    it("rejects invalid expire_in_seconds query param", async () => {
      const res = await ctx.app.request("/api/upload/oneshot?expire_in_seconds=abc", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(10),
      })
      expect(res.status).toBe(400)
    })

    it("rejects negative expire_in_seconds query param", async () => {
      const res = await ctx.app.request("/api/upload/oneshot?expire_in_seconds=-1", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(10),
      })
      expect(res.status).toBe(400)
    })
  })

  /* ── /api/download ───────────────────────────────────────────────── */

  describe("GET /api/download/:fileId", () => {
    it("rejects empty fileId", async () => {
      const res = await ctx.app.request("/api/download/")
      expect(res.status).toBe(404)
    })

    it("rejects non-existent fileId", async () => {
      const res = await ctx.app.request("/api/download/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
      expect(res.status).toBe(404)
    })

    it("rejects path-traversal fileId", async () => {
      const res = await ctx.app.request("/api/download/../")
      // Hono normalizes the path — /api/download/../ becomes /api/download/
      // which matches the route with an empty fileId → 404
      expect(res.status).toBe(404)
    })

    it("rejects fileId with slashes", async () => {
      const res = await ctx.app.request("/api/download/../../etc/passwd")
      // Hono normalizes path traversal above root → route mismatch → 404
      expect(res.status).toBe(404)
    })

    it("rejects fileId with null bytes", async () => {
      const res = await ctx.app.request("/api/download/%00")
      expect(res.status).toBe(400)
    })
  })

  /* ── Happy paths ────────────────────────────────────────────────── */

  describe("full upload → download round-trip", () => {
    it("begin → write chunks → commit → download", async () => {
      const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      // 1. Begin
      const beginRes = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: content.byteLength, expireInSeconds: FUTURE_DURATION }),
      })
      expect(beginRes.status).toBe(200)
      const { sessId } = await beginRes.json() as { success: boolean; sessId: string }
      expect(typeof sessId).toBe("string")

      // 2. Write chunks
      const writeRes = await ctx.app.request(`/api/upload/write?sessId=${sessId}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: content,
      })
      expect(writeRes.status).toBe(200)

      // 3. Commit
      const commitRes = await ctx.app.request(`/api/upload/commit?sessId=${sessId}`, {
        method: "POST",
      })
      expect(commitRes.status).toBe(200)
      const { fileId } = await commitRes.json() as { success: boolean; fileId: string }
      expect(typeof fileId).toBe("string")
      expect(fileId.length).toBe(64)

      // 4. Download and verify
      const dlRes = await ctx.app.request(`/api/download/${fileId}`)
      expect(dlRes.status).toBe(200)
      const body = await dlRes.arrayBuffer()
      expect(new Uint8Array(body)).toEqual(content)
    })

    it("begin → terminate (cancellation)", async () => {
      const beginRes = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 100, expireInSeconds: FUTURE_DURATION }),
      })
      expect(beginRes.status).toBe(200)
      const { sessId } = await beginRes.json() as { success: boolean; sessId: string }

      const termRes = await ctx.app.request(`/api/upload/terminate?sessId=${sessId}`, {
        method: "POST",
      })
      expect(termRes.status).toBe(200)

      // Download should now fail (use a valid-format but non-existent fileId)
      const fakeFileId = "A".repeat(64)
      const dlRes = await ctx.app.request(`/api/download/${fakeFileId}`)
      expect(dlRes.status).toBe(404)
    })

    it("write beyond declared size is rejected", async () => {
      const beginRes = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 5, expireInSeconds: FUTURE_DURATION }),
      })
      expect(beginRes.status).toBe(200)
      const { sessId } = await beginRes.json() as { success: boolean; sessId: string }

      // Write exactly 5 bytes — should succeed
      const write1 = await ctx.app.request(`/api/upload/write?sessId=${sessId}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(5),
      })
      expect(write1.status).toBe(200)

      // Write another 5 bytes — exceeds declaredSize, should be rejected
      const write2 = await ctx.app.request(`/api/upload/write?sessId=${sessId}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(5),
      })
      expect(write2.status).toBe(400)
    })

    it("commit with partial write is rejected", async () => {
      const beginRes = await ctx.app.request("/api/upload/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ declaredSize: 100, expireInSeconds: FUTURE_DURATION }),
      })
      expect(beginRes.status).toBe(200)
      const { sessId } = await beginRes.json() as { success: boolean; sessId: string }

      // Only write 10 bytes (declared 100)
      await ctx.app.request(`/api/upload/write?sessId=${sessId}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(10),
      })

      // Commit should reject — written size doesn't match declared
      const commitRes = await ctx.app.request(`/api/upload/commit?sessId=${sessId}`, {
        method: "POST",
      })
      expect(commitRes.status).toBe(400)
    })
  })
})
