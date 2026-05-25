import { AsyncQueue } from "@esfx/async"
import { safeJoinPath } from "../utils/safe-pathlib.js"
import { ERROR, INFO, type LogAction, type RichMessage } from "../utils/colog.js"
import { Db } from "./db.js"
import fs from "fs"
import { generateAlnumString } from "../utils/alnum.js"
import { FILE_ID_LENGTH, UPLOAD_SESSION_ID_LENGTH, type FileId, type UploadSessionId } from "./id-util.js"
import { Option } from "effect"

export interface SeedingFileInfo {
  filePath: string
  fileSize: number
  /** Timestamp (seconds) after which the file is eligible for cleanup. */
  expireTimestamp: number
}

interface WorkerUploadSession {
  id: UploadSessionId
  /** Total bytes the client declared it will upload. */
  declaredSize: number
  /** Timestamp (seconds) after which this session is considered expired. */
  expireTimestamp: number
  uploadingPath: string
  uploadingHandle: fs.promises.FileHandle
  /** False once the session enters tear-down (terminate, commit, or failure). */
  isAlive: boolean
  /** Bytes actually written to disk so far. */
  nbytesWritten: number
}

export interface WorkerState {
  logger: LogAction<RichMessage>
  db: Db
  maxAllocSize: number
  maxFileSize: number
  minExpireDuration: number
  maxExpireDuration: number
  seedingDir: string
  uploadingDir: string
  /** Sum of declaredSize across all active upload sessions + active seeding files. */
  allocSize: number
  uploadSessions: Map<UploadSessionId, WorkerUploadSession>
  seedingFiles: Map<FileId, SeedingFileInfo>
  /** Timestamp source (seconds). */
  getCurrentTimestamp: () => number
}

export interface Reply<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

/** Ask the worker to allocate space and create a temp file for a new upload. */
interface CmdUploadBeginMessage {
  kind: "CmdUploadBegin"
  /** Total file size the client intends to upload. */
  declaredSize: number
  /**
   * Duration in seconds from now after which this session should expire.
   * The worker converts this to an absolute timestamp using its own clock.
   */
  expireInSeconds: number
  reply: Reply<Option.Option<UploadSessionId>>
}

/** Write a chunk of raw bytes to an active upload session. */
interface CmdUploadWriteChunkMessage {
  kind: "CmdUploadWriteChunk"
  sessId: UploadSessionId
  chunk: Uint8Array
  reply: Reply<boolean>
}

/** Finalise an upload: rename temp file to seeding store and return a fileId. */
interface CmdUploadCommitMessage {
  kind: "CmdUploadCommit"
  sessId: UploadSessionId
  reply: Reply<Option.Option<FileId>>
}

/** Abort an upload session and clean up its temp file. */
interface CmdUploadTerminateMessage {
  kind: "CmdUploadTerminate"
  sessId: UploadSessionId
  reply: Reply<boolean>
}

/** Look up a seeding file's metadata by fileId. */
interface CmdQuerySeedingFileInfoMessage {
  kind: "CmdQuerySeedingFileInfo"
  fileId: FileId
  reply: Reply<Option.Option<SeedingFileInfo>>
}

/** Trigger a sweep of expired sessions and seeding files. */
interface CmdCleanupExpiredMessage {
  kind: "CmdCleanupExpired"
  reply: Reply<void>
}

/** Gracefully stop the worker loop. */
interface CmdShutdownMessage {
  kind: "CmdShutdown"
  reply: Reply<void>
}

/** Commands 'runWorkerLoop' accept. */
export type WorkerCmd =
  | CmdUploadBeginMessage
  | CmdUploadWriteChunkMessage
  | CmdUploadCommitMessage
  | CmdUploadTerminateMessage
  | CmdQuerySeedingFileInfoMessage
  | CmdCleanupExpiredMessage
  | CmdShutdownMessage

function generateUploadSessionId(): UploadSessionId {
  return generateAlnumString(UPLOAD_SESSION_ID_LENGTH)
}

function generateFileId(): FileId {
  return generateAlnumString(FILE_ID_LENGTH)
}

function deriveUploadingPath(uploadingDir: string, sessId: UploadSessionId): string {
  return safeJoinPath(uploadingDir, `${sessId}.dat`)
}

export function deriveSeedingPath(seedingDir: string, fileId: FileId): string {
  return safeJoinPath(seedingDir, `${fileId}.dat`)
}

/** Worker loop — processes one mailbox message at a time. */
export async function runWorkerLoop(mailbox: AsyncQueue<WorkerCmd>, state: WorkerState): Promise<void> {
  const log = state.logger

  while (true) {
    const msg = await mailbox.get()

    try {
      switch (msg.kind) {
        case "CmdUploadBegin": {
          await handleCmdUploadBegin(msg, state)
          break
        }
        case "CmdUploadWriteChunk": {
          await handleCmdUploadWriteChunk(msg, state)
          break
        }
        case "CmdUploadCommit": {
          await handleCmdUploadCommit(msg, state)
          break
        }
        case "CmdUploadTerminate": {
          await handleCmdUploadTerminate(msg, state)
          break
        }
        case "CmdQuerySeedingFileInfo": {
          handleCmdQuerySeedingFileInfo(msg, state)
          break
        }
        case "CmdCleanupExpired": {
          await handleCmdCleanupExpired(msg, state)
          break
        }
        case "CmdShutdown": {
          log.log({ level: INFO, message: "Worker shutdown requested" })

          /* Kill all active upload sessions before exiting. */
          for (const sess of state.uploadSessions.values()) {
            await removeSession(sess, state, "shutdown")
          }

          msg.reply.resolve()
          return
        }
      }
    } catch (e) {
      log.log({
        level: ERROR,
        message: `Worker: unhandled error processing ${msg.kind}: ${(e as Error).message}`
      })
      msg.reply.reject(e as Error)
    }
  }
}

/** Start a new upload session, allocating space and creating the temp file. */
async function handleCmdUploadBegin(
  msg: CmdUploadBeginMessage,
  state: WorkerState
): Promise<void> {
  const { declaredSize, expireInSeconds, reply } = msg

  state.logger.log({
    level: INFO,
    message: `UploadBegin: declaredSize=${declaredSize}, expireInSeconds=${expireInSeconds}`,
  })

  // Reject zero-size files — nothing to upload.
  if (declaredSize <= 0) {
    state.logger.log({
      level: INFO,
      message: `UploadBegin rejected: declaredSize ${declaredSize} must be positive`,
    })
    reply.resolve(Option.none())
    return
  }

  // Per-file size limit: reject if this single file exceeds the max.
  if (declaredSize > state.maxFileSize) {
    state.logger.log({
      level: INFO,
      message: `UploadBegin rejected: declaredSize ${declaredSize} exceeds maxFileSize ${state.maxFileSize}`,
    })
    reply.resolve(Option.none())
    return
  }

  // Reject non-positive expire duration.
  if (expireInSeconds <= 0) {
    state.logger.log({
      level: INFO,
      message: `UploadBegin rejected: expireInSeconds ${expireInSeconds} must be positive`,
    })
    reply.resolve(Option.none())
    return
  }

  // Minimum expire duration.
  if (expireInSeconds < state.minExpireDuration) {
    state.logger.log({
      level: INFO,
      message: `UploadBegin rejected: expireInSeconds ${expireInSeconds} is below minimum ${state.minExpireDuration}`,
    })
    reply.resolve(Option.none())
    return
  }

  // Expire duration limit: reject if duration exceeds the server-configured max.
  if (expireInSeconds > state.maxExpireDuration) {
    state.logger.log({
      level: INFO,
      message: `UploadBegin rejected: expireInSeconds ${expireInSeconds} exceeds maxExpireDuration ${state.maxExpireDuration}`,
    })
    reply.resolve(Option.none())
    return
  }

  // Convert to absolute timestamp using the server's clock.
  const expireTimestamp = state.getCurrentTimestamp() + expireInSeconds

  // Total allocation limit: reject if adding this file would exceed the server-wide cap.
  if (state.allocSize + declaredSize > state.maxAllocSize) {
    state.logger.log({
      level: INFO,
      message: `UploadBegin rejected: allocSize ${state.allocSize} + ${declaredSize} exceeds maxAllocSize ${state.maxAllocSize}`,
    })
    reply.resolve(Option.none())
    return
  }

  const sessId = generateUploadSessionId()
  const uploadingPath = deriveUploadingPath(state.uploadingDir, sessId)

  let uploadingHandle: fs.promises.FileHandle
  try {
    uploadingHandle = await fs.promises.open(uploadingPath, "w")
  } catch (e) {
    state.logger.log({
      level: ERROR,
      message: `Failed to create uploading file for session ${sessId}: ${(e as Error).message}`,
    })
    reply.resolve(Option.none())
    return
  }

  state.allocSize += declaredSize
  state.db.insertUploadSession(sessId, state.getCurrentTimestamp(), declaredSize, expireTimestamp)

  const sess: WorkerUploadSession = {
    id: sessId,
    declaredSize,
    expireTimestamp,
    uploadingPath,
    uploadingHandle,
    isAlive: true,
    nbytesWritten: 0,
  }
  state.uploadSessions.set(sessId, sess)

  state.logger.log({
    level: INFO,
    message: `UploadBegin granted: sessId=${sessId}, allocSize=${state.allocSize}`,
  })

  reply.resolve(Option.some(sessId))
}

/** Write a chunk of data to an active upload session. */
async function handleCmdUploadWriteChunk(
  msg: CmdUploadWriteChunkMessage,
  state: WorkerState
): Promise<void> {
  const { sessId, chunk, reply } = msg

  const sess = state.uploadSessions.get(sessId)
  if (!sess || !sess.isAlive) {
    reply.resolve(false)
    return
  }

  // Lazy expire
  if (state.getCurrentTimestamp() >= sess.expireTimestamp) {
    await removeSession(sess, state, "expired")
    reply.resolve(false)
    return
  }

  // Prevent write overflow
  if (chunk.byteLength + sess.nbytesWritten > sess.declaredSize) {
    state.logger.log({
      level: INFO,
      message: `UploadWriteChunk rejected: chunk ${chunk.byteLength} + written ${sess.nbytesWritten} > declared ${sess.declaredSize} (sessId=${sessId})`,
    })
    await removeSession(sess, state, "size_exceeded")
    reply.resolve(false)
    return
  }

  try {
    await sess.uploadingHandle.write(chunk)
    sess.nbytesWritten += chunk.byteLength
    reply.resolve(true)
  } catch (e) {
    state.logger.log({
      level: ERROR,
      message: `UploadWriteChunk failed for sessId=${sessId}: ${(e as Error).message}`,
    })
    await removeSession(sess, state, "write_failure")
    reply.resolve(false)
  }
}

/** Finalise an upload: close temp file, rename to seeding path, return fileId. */
async function handleCmdUploadCommit(
  msg: CmdUploadCommitMessage,
  state: WorkerState
): Promise<void> {
  const { sessId, reply } = msg

  const sess = state.uploadSessions.get(sessId)
  if (!sess || !sess.isAlive) {
    reply.resolve(Option.none())
    return
  }

  // Lazy expire
  if (state.getCurrentTimestamp() >= sess.expireTimestamp) {
    await removeSession(sess, state, "expired")
    reply.resolve(Option.none())
    return
  }

  // Reject immediately if the client didn't write the declared size.
  if (sess.nbytesWritten !== sess.declaredSize) {
    state.logger.log({
      level: INFO,
      message: `UploadCommit rejected: nbytesWritten ${sess.nbytesWritten} !== declaredSize ${sess.declaredSize} (sessId=${sessId})`,
    })
    await removeSession(sess, state, "size_mismatch")
    reply.resolve(Option.none())
    return
  }

  sess.isAlive = false
  state.uploadSessions.delete(sess.id)

  /* Move the file to seeding */
  const fileId = generateFileId()
  const seedingPath = deriveSeedingPath(state.seedingDir, fileId)
  await sess.uploadingHandle.close()
  try {
    await fs.promises.rename(sess.uploadingPath, seedingPath)
  } catch (e) {
    state.logger.log({
      level: ERROR,
      message: `UploadCommit rename failed (sessId=${sessId}, fileId=${fileId}): ${(e as Error).message}`,
    })
    reply.resolve(Option.none())
    return
  }

  /* Persist to DB. */
  state.db.insertSeedingFile(fileId, sess.declaredSize, sess.expireTimestamp)

  state.seedingFiles.set(fileId, {
    filePath: seedingPath,
    fileSize: sess.declaredSize,
    expireTimestamp: sess.expireTimestamp,
  })

  state.logger.log({
    level: INFO,
    message: `UploadCommit success: fileId=${fileId}, size=${sess.declaredSize}`,
  })

  reply.resolve(Option.some(fileId))
}

/** Abort an upload session: remove temp file and release allocation. */
async function handleCmdUploadTerminate(
  msg: CmdUploadTerminateMessage,
  state: WorkerState
): Promise<void> {
  const { sessId, reply } = msg

  const sess = state.uploadSessions.get(sessId)
  if (!sess || !sess.isAlive) {
    reply.resolve(false)
    return
  }

  await removeSession(sess, state, "terminated")
  reply.resolve(true)
}

/** Look up a seeding file's info by fileId. Returns None if expired or missing. */
function handleCmdQuerySeedingFileInfo(
  msg: CmdQuerySeedingFileInfoMessage,
  state: WorkerState
): void {
  const { fileId, reply } = msg

  const info = state.seedingFiles.get(fileId)
  if (!info) {
    reply.resolve(Option.none())
    return
  }

  if (state.getCurrentTimestamp() >= info.expireTimestamp) {
    reply.resolve(Option.none())
    return
  }

  reply.resolve(Option.some(info))
}

/** Periodic sweep of expired sessions and seeding files. */
async function handleCmdCleanupExpired(
  msg: CmdCleanupExpiredMessage,
  state: WorkerState
): Promise<void> {
  const now = state.getCurrentTimestamp()
  const log = state.logger

  /* Expired upload sessions. */
  const expiredSessions: WorkerUploadSession[] = []
  for (const sess of state.uploadSessions.values()) {
    if (sess.isAlive && now >= sess.expireTimestamp) {
      expiredSessions.push(sess)
    }
  }

  for (const sess of expiredSessions) {
    await removeSession(sess, state, "expired")
  }

  /* Expired seeding files: remove from DB and disk. */
  const expiredFromDb = state.db.expireOldSeedingFiles(now)
  for (const { id, size } of expiredFromDb) {
    const info = state.seedingFiles.get(id)
    if (info) {
      state.seedingFiles.delete(id)
      state.allocSize -= size

      log.log({
        level: INFO,
        message: `CleanupExpired: removing seeding file fileId=${id}, size=${size}, expireTs=${info.expireTimestamp}, nowTs=${now}`,
      })

      try {
        await fs.promises.unlink(info.filePath)
      } catch (e) {
        log.log({
          level: ERROR,
          message: `CleanupExpired: failed to delete seeding file ${id}: ${(e as Error).message}`,
        })
      }
    }
  }

  msg.reply.resolve()
}

/**
 * Remove an upload session: close handle, delete temp file, release allocation,
 * and record termination reason in the audit log.
 */
async function removeSession(
  sess: WorkerUploadSession,
  state: WorkerState,
  reason?: string
): Promise<void> {
  if (!sess.isAlive) return

  sess.isAlive = false
  state.uploadSessions.delete(sess.id)
  state.allocSize -= sess.declaredSize

  if (reason) {
    state.db.terminateUploadSession(sess.id, state.getCurrentTimestamp(), reason)
  }

  state.logger.log({
    level: INFO,
    message: `removeSession: sessId=${sess.id}, reason=${reason ?? "none"}, allocSize=${state.allocSize}`,
  })

  await sess.uploadingHandle.close()

  try {
    await fs.promises.unlink(sess.uploadingPath)
  } catch (e) {
    state.logger.log({
      level: ERROR,
      message: `removeSession: failed to delete uploading file ${sess.id}: ${(e as Error).message}`,
    })
  }
}

