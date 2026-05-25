import { VITE_DEFAULT_API_URL } from "@/feats/env-config/env-config"
import { Either, Schema } from "effect"

export type FileID = string
export type UploadSessionID = string

const FileIDSchema = Schema.String
const UploadSessionIDSchema = Schema.String


export async function uploadChunkedBegin(declaredSize: number, expireInSeconds: number): Promise<Either.Either<string, UploadSessionID>> {
  const response = await fetch(`${VITE_DEFAULT_API_URL}/upload/begin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ declaredSize, expireInSeconds }),
  })
  if (!response.ok) {
    return Either.left(await response.text())
  }

  const result = Schema.decodeSync(Schema.Struct({
    success: Schema.Boolean,
    sessId: UploadSessionIDSchema,
  }))(await response.json())

  return Either.right(result.sessId)
}

export async function uploadChunkedWriteChunk(sessID: UploadSessionID, chunkData: Uint8Array<ArrayBuffer>): Promise<Either.Either<undefined, string>> {
  const url = new URL(`${VITE_DEFAULT_API_URL}/upload/write`)
  url.searchParams.set("sessId", sessID)

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Blob([chunkData]),
  })
  if (!response.ok) {
    const errmsg = await response.text()
    return Either.left(errmsg)
  }

  Schema.decodeSync(Schema.Struct({
    success: Schema.Boolean,
  }))(await response.json())

  return Either.right(undefined)
}

export async function uploadChunkedCommit(sessID: UploadSessionID): Promise<Either.Either<string, FileID>> {
  const url = new URL(`${VITE_DEFAULT_API_URL}/upload/commit`)
  url.searchParams.set("sessId", sessID)

  const response = await fetch(url, { method: "POST" })
  if (!response.ok) {
    const errmsg = await response.text()
    return Either.left(errmsg)
  }

  const result = Schema.decodeSync(Schema.Struct({
    success: Schema.Boolean,
    fileId: FileIDSchema,
  }))(await response.json())
  return Either.right(result.fileId)
}

export async function uploadChunkedTerminate(sessID: UploadSessionID): Promise<Either.Either<undefined, string>> {
  const url = new URL(`${VITE_DEFAULT_API_URL}/upload/terminate`)
  url.searchParams.set("sessId", sessID)

  const response = await fetch(url, { method: "POST" })
  if (!response.ok) {
    const errmsg = await response.text()
    return Either.left(errmsg)
  }

  Schema.decodeSync(Schema.Struct({
    success: Schema.Boolean,
  }))(await response.json())

  return Either.right(undefined)
}
