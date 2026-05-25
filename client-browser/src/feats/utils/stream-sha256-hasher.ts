import sodium from "libsodium-wrappers-sumo"
import { createTeeTransformStream } from "./stream-tee"
import { uint8ArrayToHex } from "./hex"
import { Option } from "effect"

export const SHA256_HASH_NBYTES = 32

export interface SHA256Hasher {
  update: (data: Uint8Array) => void

  getHexDigest: () => string
  getDigest: () => Uint8Array
}

export async function createSHA256Hasher(): Promise<SHA256Hasher> {
  await sodium.ready
  const state = sodium.crypto_hash_sha256_init()

  let isFinalized = false
  let finalDigest = Option.none<Uint8Array>()

  /*
   * NOTE: libsodium makes the state un-updateable after finalization. We have
   * to cache the final diges
   */
  const ensureFinalize = () => {
    if (!isFinalized) {
      finalDigest = Option.some(sodium.crypto_hash_sha256_final(state))
      isFinalized = true
    }
  }

  const getDigest = () => {
    ensureFinalize()
    return Option.getOrThrow(finalDigest)
  }

  return {
    update(chunk) {
      if (isFinalized) {
        throw new Error("SHA256Hasher already finalized. Can no longer update with new data.")
      }
      sodium.crypto_hash_sha256_update(state, chunk)
    },
    getHexDigest() {
      return uint8ArrayToHex(getDigest())
    },
    getDigest() {
      return getDigest()
    }
  }
}

export function createSHA256TransformStream(hasher: SHA256Hasher): TransformStream<Uint8Array> {
  return createTeeTransformStream((chunk) => {
    hasher.update(chunk)
  })
}
