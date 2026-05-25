
/**
 * Merges multiple Uint8Array buffers into a single Uint8Array.
 */
export function mergeBuffers(buffers: Array<Uint8Array>): Uint8Array {
  let totalSize = 0

  for (const buffer of buffers) {
    totalSize += buffer.length
  }

  const mergedBuffer = new Uint8Array(totalSize)
  let offset = 0

  for (const buffer of buffers) {
    mergedBuffer.set(buffer, offset)
    offset += buffer.length
  }

  return mergedBuffer
}
