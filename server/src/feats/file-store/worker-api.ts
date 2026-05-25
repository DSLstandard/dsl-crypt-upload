import { AsyncQueue } from "@esfx/async"
import { safeJoinPath } from "../utils/safe-pathlib.js"
import { LogAction, WARN, type RichMessage } from "../utils/colog.js"
import fs from "fs"
import { getCurrentTimestamp as realNow } from "../utils/time.js"
import { type FileId, type UploadSessionId } from "./id-util.js"
import { Option } from "effect"
import {
  type SeedingFileInfo,
  type Reply,
  type WorkerCmd,
  type WorkerState,
  runWorkerLoop,
  deriveSeedingPath,
} from "./worker.js"
import type { Db } from "./db.js"

export interface FileStoreBootupParams {
  logger: LogAction<RichMessage>
  /** Maximum aggregate bytes across all active uploads. */
  maxAllocSize: number
  /** Maximum bytes for a single file. */
  maxFileSize: number
  /** Minimum allowed expire duration in seconds (from now). */
  minExpireDuration: number
  /** Maximum allowed expire duration in seconds (from now). */
  maxExpireDuration: number
  filesDir: string
  db: Db
  /** Timestamp source (seconds). Override for time control in tests. */
  getCurrentTimestamp?: () => number
}


/** Public API: enqueue messages into the worker's mailbox and await replies. */
export class FileStoreWorkerAPI {
  private readonly mailbox: AsyncQueue<WorkerCmd>
  private readonly workerReady: Promise<void>
  private readonly seedingDir: string
  private readonly settings: { maxFileSize: number; minExpireDuration: number; maxExpireDuration: number }

  private constructor(
    mailbox: AsyncQueue<WorkerCmd>,
    workerReady: Promise<void>,
    seedingDir: string,
    settings: { maxFileSize: number; minExpireDuration: number; maxExpireDuration: number },
  ) {
    this.mailbox = mailbox
    this.workerReady = workerReady
    this.seedingDir = seedingDir
    this.settings = settings
  }

  /** Expose server settings for the /api/server-settings endpoint. */
  getServerSettings(): { maxFileSize: number; minExpireDuration: number; maxExpireDuration: number } {
    return this.settings
  }

  /**
   * Boot up the file store worker: prepare directories, clean up leftovers from
   * previous runs, load active seeding files from the DB, and start the worker
   * loop.
   */
  static async bootup(params: FileStoreBootupParams): Promise<FileStoreWorkerAPI> {
    const seedingDir = safeJoinPath(params.filesDir, "seeding")
    const uploadingDir = safeJoinPath(params.filesDir, "uploading")

    await fs.promises.mkdir(seedingDir, { recursive: true })
    await fs.promises.mkdir(uploadingDir, { recursive: true })

    /* ── Startup cleanup ──────────────────────────────────────────── */

    /* Delete leftover uploading files from previous runs. */
    const uploadingFiles = await fs.promises.readdir(uploadingDir)
    for (const f of uploadingFiles) {
      try {
        await fs.promises.unlink(safeJoinPath(uploadingDir, f))
      } catch (e) {
        params.logger.log({
          level: WARN,
          message: `Startup: failed to delete leftover uploading file ${f}: ${(e as Error).message}`,
        })
      }
    }

    const nowFn = params.getCurrentTimestamp ?? realNow
    const nowTs = nowFn()

    /* Prune expired seeding files from DB and disk. */
    const expiredSeeding = params.db.expireOldSeedingFiles(nowTs)
    for (const { id } of expiredSeeding) {
      const path = deriveSeedingPath(seedingDir, id)
      try {
        await fs.promises.unlink(path)
      } catch (e) {
        params.logger.log({
          level: WARN,
          message: `Startup: failed to delete expired seeding file ${id}: ${(e as Error).message}`,
        })
      }
    }

    /* Load active seeding files from DB, verifying disk existence. */
    const activeSeedingFiles = params.db.getActiveSeedingFiles(nowTs)
    const seedingFiles = new Map<FileId, SeedingFileInfo>()
    for (const sf of activeSeedingFiles) {
      const path = deriveSeedingPath(seedingDir, sf.id)
      try {
        await fs.promises.access(path, fs.constants.F_OK)
        seedingFiles.set(sf.id, {
          filePath: path,
          fileSize: sf.size,
          expireTimestamp: sf.expireTs,
        })
      } catch {
        params.logger.log({
          level: WARN,
          message: `Startup: seeding file ${sf.id} is in DB but missing from disk — soft-deleting`,
        })
        params.db.softDeleteSeedingFile(sf.id)
      }
    }

    /* Terminate any upload sessions still marked as active in the DB. */
    params.db.terminateAllActiveSessions(nowTs, "server_restart")

    /* Initialise allocSize from surviving seeding files (no active uploads). */
    let allocSize = 0
    for (const info of seedingFiles.values()) {
      allocSize += info.fileSize
    }

    const state: WorkerState = {
      logger: params.logger,
      db: params.db,
      maxAllocSize: params.maxAllocSize,
      maxFileSize: params.maxFileSize,
      minExpireDuration: params.minExpireDuration,
      maxExpireDuration: params.maxExpireDuration,
      seedingDir,
      uploadingDir,
      allocSize,
      uploadSessions: new Map(),
      seedingFiles,
      getCurrentTimestamp: nowFn,
    }

    const mailbox = new AsyncQueue<WorkerCmd>()
    const workerReady = runWorkerLoop(mailbox, state)

    return new FileStoreWorkerAPI(mailbox, workerReady, seedingDir, {
      maxFileSize: params.maxFileSize,
      minExpireDuration: params.minExpireDuration,
      maxExpireDuration: params.maxExpireDuration,
    })
  }

  requestUploadBegin(params: {
    declaredSize: number
    /** Duration in seconds from now (server clock) until this session expires. */
    expireInSeconds: number
  }): Promise<Option.Option<UploadSessionId>> {
    return this.sendWithReply((reply) => ({
      kind: "CmdUploadBegin",
      declaredSize: params.declaredSize,
      expireInSeconds: params.expireInSeconds,
      reply,
    }))
  }

  requestUploadWriteChunk(sessId: UploadSessionId, chunk: Uint8Array): Promise<boolean> {
    return this.sendWithReply((reply) => ({
      kind: "CmdUploadWriteChunk",
      sessId,
      chunk,
      reply,
    }))
  }

  requestUploadCommit(sessId: UploadSessionId): Promise<Option.Option<FileId>> {
    return this.sendWithReply((reply) => ({
      kind: "CmdUploadCommit",
      sessId,
      reply,
    }))
  }

  requestUploadTerminate(sessId: UploadSessionId): Promise<boolean> {
    return this.sendWithReply((reply) => ({
      kind: "CmdUploadTerminate",
      sessId,
      reply,
    }))
  }

  querySeedingFileInfo(fileId: FileId): Promise<Option.Option<SeedingFileInfo>> {
    return this.sendWithReply((reply) => ({
      kind: "CmdQuerySeedingFileInfo",
      fileId,
      reply,
    }))
  }

  getSeedingFilePath(fileId: FileId): string {
    return deriveSeedingPath(this.seedingDir, fileId)
  }

  cleanupExpired(): Promise<void> {
    return this.sendWithReply((reply) => ({
      kind: "CmdCleanupExpired",
      reply,
    }))
  }

  async shutdown(): Promise<void> {
    await this.sendWithReply((reply) => ({ kind: "CmdShutdown", reply }))
    await this.workerReady
  }

  private sendWithReply<T>(makeMsg: (reply: Reply<T>) => WorkerCmd): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const msg = makeMsg({ resolve, reject })
      this.mailbox.put(msg)
    })
  }
}
