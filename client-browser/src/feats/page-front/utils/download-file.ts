import { createChaCha20TransformStream, createZeroNonce, CHACHA20_KEY_NBYTES } from "../../utils/stream-chacha20-cipher"
import { createSHA256Hasher, createSHA256TransformStream, SHA256_HASH_NBYTES } from "../../utils/stream-sha256-hasher"
import { uint8ArrayToHex } from "../../utils/hex"
import { VITE_DEFAULT_API_URL } from "../../env-config/env-config"

export interface DownloadParams {
  fileID: string
  fileName: string
  key: Uint8Array
  hash: Uint8Array
}

export type DownloadResult =
  | { tag: "ok" }
  | { tag: "hash-mismatch"; expected: string; got: string }
  | { tag: "error"; message: string }

/**
 * Fetch encrypted file from server, decrypt via ChaCha20, SHA-256 hash (tee),
 * pipe plaintext to writeStream, and verify hash matches expected.
 */
export async function downloadFile(
  params: DownloadParams,
  writeStream: WritableStream,
): Promise<DownloadResult> {
  if (params.key.length !== CHACHA20_KEY_NBYTES) {
    return { tag: "error", message: `Invalid key length: ${params.key.length} bytes` }
  }
  if (params.hash.length !== SHA256_HASH_NBYTES) {
    return { tag: "error", message: `Invalid hash length: ${params.hash.length} bytes` }
  }

  let res: Response
  try {
    res = await fetch(`${VITE_DEFAULT_API_URL}/download/${params.fileID}`)
  } catch (err) {
    return { tag: "error", message: `Network error: ${err}` }
  }

  if (!res.ok) {
    return { tag: "error", message: `Server responded ${res.status}: ${await res.text()}` }
  }

  const body = res.body
  if (!body) {
    return { tag: "error", message: "Server returned empty body" }
  }

  const hasher = await createSHA256Hasher()
  const decrypt = await createChaCha20TransformStream({ key: params.key, nonce: createZeroNonce() })

  try {
    await body
      .pipeThrough(decrypt)
      .pipeThrough(createSHA256TransformStream(hasher))
      .pipeTo(writeStream)
  } catch (err) {
    return { tag: "error", message: `Download/decrypt failed: ${err}` }
  }

  const got = hasher.getHexDigest()
  const expected = uint8ArrayToHex(params.hash)

  if (got !== expected) {
    return { tag: "hash-mismatch", expected, got }
  }

  return { tag: "ok" }
}
