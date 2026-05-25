import { type Hono } from 'hono'
import { stream } from 'hono/streaming'
import fs from "fs"
import { HttpStatus } from "http-status-ts"
import { validator } from 'hono/validator'
import { Option, Either, Schema } from 'effect'
import type { FileStoreWorkerAPI } from '../file-store/worker-api.js'
import type { LogAction, RichMessage } from '../utils/colog.js'
import { FileIdSchema, UploadSessionIdSchema } from '../file-store/id-util.js'

/**
 * Wire file-share routes onto an existing Hono app.
 * CORS and other app-level middleware should be applied by the caller.
 */
export function createHonoServer(
  app: Hono,
  fileStore: FileStoreWorkerAPI,
  appLogger: LogAction<RichMessage>,
): Hono {
  /* ── GET /api/server-settings ───────────────────────────────────────── */
  app.get("/api/server-settings", (c) => {
    const settings = fileStore.getServerSettings()
    return c.json(settings)
  })

  /* ── POST /api/upload/begin ──────────────────────────────────────────── */
  app.post("/api/upload/begin",
    validator("json", (value, c) => {
      const result = Schema.decodeUnknownEither(
        Schema.Struct({
          declaredSize: Schema.Int.pipe(Schema.positive()),
          expireInSeconds: Schema.Int.pipe(Schema.positive()),
        })
      )(value)
      if (Either.isLeft(result)) {
        return c.json({ error: "Invalid request body" }, HttpStatus.BAD_REQUEST)
      }
      return result.right
    }),
    async (c) => {
      const { declaredSize, expireInSeconds } = c.req.valid("json")
      const result = await fileStore.requestUploadBegin({ declaredSize, expireInSeconds })

      if (Option.isSome(result)) {
        return c.json({ success: true, sessId: result.value })
      }

      return c.json({ error: "Upload request rejected by the server" }, HttpStatus.BAD_REQUEST)
    }
  )

  /* ── POST /api/upload/write ──────────────────────────────────────────── */
  app.post("/api/upload/write",
    validator("query", (value, c) => {
      const result = Schema.decodeUnknownEither(
        Schema.Struct({ sessId: UploadSessionIdSchema })
      )(value)
      if (Either.isLeft(result)) {
        return c.json({ error: "Invalid query parameters" }, HttpStatus.BAD_REQUEST)
      }
      return result.right
    }),
    async (c) => {
      const { sessId } = c.req.valid("query")

      const bodyStream = c.req.raw.body
      if (!bodyStream) {
        return c.json({ error: "Request body is empty" }, HttpStatus.BAD_REQUEST)
      }

      for await (const chunk of bodyStream) {
        const ok = await fileStore.requestUploadWriteChunk(sessId, chunk)
        if (!ok) {
          return c.json({ error: "Upload write rejected by the server" }, HttpStatus.BAD_REQUEST)
        }
      }

      return c.json({ success: true })
    }
  )

  /* ── POST /api/upload/commit ─────────────────────────────────────────── */
  app.post("/api/upload/commit",
    validator("query", (value, c) => {
      const result = Schema.decodeUnknownEither(
        Schema.Struct({ sessId: UploadSessionIdSchema })
      )(value)
      if (Either.isLeft(result)) {
        return c.json({ error: "Invalid query parameters" }, HttpStatus.BAD_REQUEST)
      }
      return result.right
    }),
    async (c) => {
      const { sessId } = c.req.valid("query")

      const result = await fileStore.requestUploadCommit(sessId)
      if (Option.isNone(result)) {
        return c.json({ error: "Upload commit rejected by the server" }, HttpStatus.BAD_REQUEST)
      }

      return c.json({ success: true, fileId: result.value })
    }
  )

  /* ── POST /api/upload/oneshot ─────────────────────────────────────────── */
  app.post("/api/upload/oneshot",
    validator("header", (value, c) => {
      const result = Schema.decodeUnknownEither(
        Schema.Struct({
          "content-length": Schema.NumberFromString.pipe(
            Schema.filter((n) => Number.isInteger(n) && n > 0)
          ),
        })
      )(value)
      if (Either.isLeft(result)) {
        return c.json({ error: "Missing or invalid Content-Length header" }, HttpStatus.BAD_REQUEST)
      }
      return result.right
    }),
    validator("query", (value, c) => {
      const result = Schema.decodeUnknownEither(Schema.Struct({
        expire_in_seconds: Schema.optional(
          Schema.NumberFromString.pipe(Schema.filter((n) => Number.isInteger(n) && n > 0))
        ),
      }))(value)
      if (Either.isLeft(result)) {
        return c.json({ error: "Invalid query parameters" }, HttpStatus.BAD_REQUEST)
      }
      return result.right
    }),
    async (c) => {
      const { "content-length": declaredSize } = c.req.valid("header")
      const { expire_in_seconds } = c.req.valid("query")
      const expireInSeconds = expire_in_seconds ?? 3600

      /* Begin — declare size from Content-Length header */
      const beginResult = await fileStore.requestUploadBegin({ declaredSize, expireInSeconds })
      if (Option.isNone(beginResult)) {
        return c.json({ error: "Upload request rejected by server" }, HttpStatus.BAD_REQUEST)
      }
      const sessId = beginResult.value

      /* Stream body chunks directly to worker — no buffering */
      const bodyStream = c.req.raw.body
      if (!bodyStream) {
        await fileStore.requestUploadTerminate(sessId)
        return c.json({ error: "Request body is empty" }, HttpStatus.BAD_REQUEST)
      }

      try {
        for await (const chunk of bodyStream) {
          const ok = await fileStore.requestUploadWriteChunk(sessId, chunk as Uint8Array<ArrayBuffer>)
          if (!ok) {
            await fileStore.requestUploadTerminate(sessId)
            return c.json({ error: "Upload write rejected by server" }, HttpStatus.BAD_REQUEST)
          }
        }
      } catch {
        await fileStore.requestUploadTerminate(sessId)
        return c.json({ error: "Upload stream failed" }, HttpStatus.INTERNAL_SERVER_ERROR)
      }

      /* Commit */
      const commitResult = await fileStore.requestUploadCommit(sessId)
      if (Option.isNone(commitResult)) {
        return c.json({ error: "Upload commit rejected by server" }, HttpStatus.BAD_REQUEST)
      }

      return c.json({ success: true, fileId: commitResult.value })
    }
  )

  /* ── POST /api/upload/terminate ──────────────────────────────────────── */
  app.post("/api/upload/terminate",
    validator("query", (value, c) => {
      const result = Schema.decodeUnknownEither(
        Schema.Struct({ sessId: UploadSessionIdSchema })
      )(value)
      if (Either.isLeft(result)) {
        return c.json({ error: "Invalid query parameters" }, HttpStatus.BAD_REQUEST)
      }
      return result.right
    }),
    async (c) => {
      const { sessId } = c.req.valid("query")
      const ok = await fileStore.requestUploadTerminate(sessId)
      if (!ok) {
        return c.json({ error: "Session not found or already terminated" }, HttpStatus.BAD_REQUEST)
      }
      return c.json({ success: true })
    }
  )

  /* ── GET /api/download/:fileId ───────────────────────────────────────── */
  app.get("/api/download/:fileId",
    validator("param", (value, c) => {
      const result = Schema.decodeUnknownEither(
        Schema.Struct({ fileId: FileIdSchema })
      )(value)
      if (Either.isLeft(result)) {
        return c.json({ error: "Invalid file ID in URL parameter" }, HttpStatus.BAD_REQUEST)
      }
      return result.right
    }),
    async (c) => {
      const fileId = c.req.valid("param").fileId

      const fileInfoMaybe = await fileStore.querySeedingFileInfo(fileId)
      if (Option.isNone(fileInfoMaybe)) {
        return c.json({ error: "File not found or expired" }, HttpStatus.NOT_FOUND)
      }

      const { fileSize, filePath } = fileInfoMaybe.value

      c.header("Content-Type", "application/octet-stream")
      c.header("Content-Length", fileSize.toString())

      return stream(c, async (stream) => {
        let fileHandle: fs.promises.FileHandle
        try {
          fileHandle = await fs.promises.open(filePath, "r")
        } catch (e) {
          appLogger.log({
            level: "ERROR",
            message: `Failed to open seeding file for download fileId=${fileId}: ${(e as Error).message}`
          })
          return
        }

        try {
          const readStream = fileHandle.createReadStream()
          for await (const chunk of readStream) {
            await stream.write(chunk)
          }
        } finally {
          await fileHandle.close()
        }
      })
    }
  )

  return app
}
