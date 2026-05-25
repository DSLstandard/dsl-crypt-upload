import { Either, Option } from "effect"
import { createChaCha20Cipher, createZeroNonce } from "../../utils/stream-chacha20-cipher"
import { createSHA256Hasher } from "../../utils/stream-sha256-hasher"
import { uploadChunkedBegin, uploadChunkedTerminate, uploadChunkedWriteChunk, uploadChunkedCommit } from "./upload-api";

export type UploadResult =
  | { tag: "error"; message: string }
  | { tag: "ok"; fileID: string; hash: Uint8Array }

export type ProgressCb = (uploadedBytes: number) => void

/**
 * Encrypt a file with ChaCha20 + SHA-256 hash (tee'd), then chunk-upload to
 * server and commit. Returns the file ID and original-file hash on success.
 */
export async function uploadFile(
  file: File,
  key: Uint8Array,
  onProgress: ProgressCb,
  expireDurationSeconds: number,
): Promise<UploadResult> {
  /* 1. Begin upload session — server converts expireDurationSeconds to its own absolute timestamp */
  const begin = await uploadChunkedBegin(file.size, expireDurationSeconds)
  if (Either.isLeft(begin)) {
    return { tag: "error", message: begin.left }
  }
  const sessID = begin.right

  const terminate = async () => { void uploadChunkedTerminate(sessID) }

  try {
    /* 2. Initialize crypto */
    const hasher = await createSHA256Hasher()
    const encrypter = await createChaCha20Cipher({ key, nonce: createZeroNonce() })

    const flushEncrypter = (): Uint8Array[] => {
      const chunks: Uint8Array[] = []
      while (true) {
        const m = encrypter.pull()
        if (Option.isNone(m)) {
          break
        } else {
          chunks.push(m.value)
        }

      }
      return chunks
    }

    /* 3. Read file chunks, hash + encrypt in a single pass */
    const reader = file.stream().getReader()
    let uploadedBytes = 0

    for (; ;) {
      const { done, value } = await reader.read()
      if (done) break

      hasher.update(value)
      encrypter.push(value)

      for (const chunk of flushEncrypter()) {
        const res = await uploadChunkedWriteChunk(sessID, chunk as Uint8Array<ArrayBuffer>)
        if (Either.isLeft(res)) {
          await terminate()
          return { tag: "error", message: res.left }
        }
        uploadedBytes += chunk.length
        onProgress(uploadedBytes)
      }
    }

    /* 4. Flush remaining encrypted data */
    encrypter.end()
    for (const chunk of flushEncrypter()) {
      const res = await uploadChunkedWriteChunk(sessID, chunk as Uint8Array<ArrayBuffer>)
      if (Either.isLeft(res)) {
        await terminate()
        return { tag: "error", message: res.left }
      }
      uploadedBytes += chunk.length
      onProgress(uploadedBytes)
    }

    /* 5. Commit */
    const commit = await uploadChunkedCommit(sessID)
    if (Either.isLeft(commit)) {
      await terminate()
      return { tag: "error", message: commit.left }
    }

    return { tag: "ok", fileID: commit.right, hash: hasher.getDigest() }
  } catch (err) {
    await terminate()
    return { tag: "error", message: String(err) }
  }
}
