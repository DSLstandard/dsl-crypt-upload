import { Option } from "effect"
import { createBufferChunker } from "./stream-buffer-chunker"
import sodium from "libsodium-wrappers-sumo"

export const CHACHA20_KEY_NBYTES = 32
export const CHACHA20_NONCE_NBYTES = 8
export const CHACHA20_BLOCK_NBYTES = 64

export function generateChaCha20Key(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CHACHA20_KEY_NBYTES))
}

export interface ChaCha20CipherParams {
  key: Uint8Array
  nonce: Uint8Array

  /**
   * Number of 64 bytes blocks to process per pull call. The larger the more a
   * single sodium call can process and thus potentially faster.
   */
  processNBlocksPerCall?: number
}

export interface ChaCha20Cipher {
  /** Feed a chunk of plain data to be encrypted. */
  push: (data: Uint8Array) => void

  /** Signal no more plain chunk will be fed. */
  end: () => void

  /**
   * Pull out a chunk of encrypted data. If there is not enough plain data to
   * form a 64 bytes chunk for ChaCha20, returns None.
   *
   * Last chunk pulled might be smaller than 64 bytes.
   */
  pull: () => Option.Option<Uint8Array>
}

export async function createChaCha20Cipher({ key, nonce, processNBlocksPerCall = 8192 }: ChaCha20CipherParams): Promise<ChaCha20Cipher> {
  await sodium.ready

  if (key.length !== CHACHA20_KEY_NBYTES) {
    throw new Error(`Invalid key length: expected ${CHACHA20_KEY_NBYTES} bytes, got ${key.length} bytes`)
  }

  if (nonce.length !== CHACHA20_NONCE_NBYTES) {
    throw new Error(`Invalid nonce length: expected ${CHACHA20_NONCE_NBYTES} bytes, got ${nonce.length} bytes`)
  }

  const chunker = createBufferChunker(CHACHA20_BLOCK_NBYTES * processNBlocksPerCall)
  let ic = 0

  return {
    push(chunk) {
      chunker.push(chunk)
    },
    end() {
      chunker.end()
    },
    pull() {
      const plainChunkMaybe = chunker.pull()
      if (Option.isNone(plainChunkMaybe)) {
        return Option.none()
      }

      const plainChunk = plainChunkMaybe.value
      const cryptChunk = sodium.crypto_stream_chacha20_xor_ic(plainChunk, nonce, ic, key)
      ic += processNBlocksPerCall

      return Option.some(cryptChunk)
    }
  }
}

/**
 * Create a TransformStream out of a ChaCha20Cipher.
 */
export async function createChaCha20TransformStream(params: ChaCha20CipherParams): Promise<TransformStream<Uint8Array>> {
  const chacha20 = await createChaCha20Cipher(params)

  const flush = (controller: TransformStreamDefaultController<Uint8Array<ArrayBufferLike>>) => {
    while (true) {
      const outChunkMaybe = chacha20.pull()
      if (Option.isNone(outChunkMaybe)) {
        break
      }

      const outChunk = outChunkMaybe.value
      controller.enqueue(outChunk)
    }
  }

  return new TransformStream<Uint8Array>({
    transform: async (inChunkPromise, controller) => {
      const inChunk = await inChunkPromise
      chacha20.push(inChunk)
      flush(controller)
    },
    flush: async (controller) => {
      chacha20.end()
      flush(controller)
    }
  })
}

/**
 * Create a zero-filled nonce.
 */
export function createZeroNonce(): Uint8Array {
  return new Uint8Array(CHACHA20_NONCE_NBYTES)
}
