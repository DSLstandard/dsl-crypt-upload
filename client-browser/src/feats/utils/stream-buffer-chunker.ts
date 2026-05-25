import { Option } from "effect"
import { mergeBuffers } from "./merge-buffers"

export interface BufferChunker {
  /** Feed a chunk */
  push: (data: Uint8Array) => void

  /** Signal no more chunk will be fed */
  end: () => void

  /**
   * Pull out a chunk of the specified size. If there is not enough data to form
   * a fixed size chunk, return None. If the stream has ended, can be continued
   * to be pulled. The last chunk pulled might be smaller than the specified
   * size.
   */
  pull: () => Option.Option<Uint8Array>
}

/**
 * 'BufferChunker' takes in arbitrary Uint8Array chunks and reorganize chunks
 * into fixed-size chunks. Final chunk can be smaller than the fixed size.
 */
export function createBufferChunker(emitChunkSize: number): BufferChunker {
  const queue: Array<Uint8Array> = []
  let isEnded = false

  interface BufferedPrefix {
    count: number
    sizeSum: number
  }
  const bufferedPrefix: BufferedPrefix = { count: 0, sizeSum: 0 }

  const resetBufferedPrefix = () => {
    bufferedPrefix.count = 0
    bufferedPrefix.sizeSum = 0
  }

  const trackBufferedPrefix = () => {
    for (let i = bufferedPrefix.count; i < queue.length; i++) {
      const chunk = queue[i]
      if (bufferedPrefix.sizeSum + chunk.length <= emitChunkSize) {
        bufferedPrefix.count += 1
        bufferedPrefix.sizeSum += chunk.length
      } else {
        break
      }
    }
  }

  const drainOutQueue = () => {
    const toReturn = mergeBuffers(queue)
    queue.length = 0
    return toReturn
  }

  return {
    push(data) {
      if (isEnded) {
        throw new Error("Stream already ended")
      }

      if (data.length === 0) {
        return
      }

      queue.push(data)
    },
    end() {
      if (isEnded) {
        throw new Error("Stream already ended")
      }

      isEnded = true
    },
    pull() {
      if (queue.length === 0) {
        return Option.none()
      }

      trackBufferedPrefix()

      // If the buffered prefix's count is less than the queue length, it means
      // there is one chunk (the 'critical' chunk) after the buffered prefix
      // that has enough data to reach 'chunkSize'.
      const couldEmitChunk = bufferedPrefix.count < queue.length
      if (!couldEmitChunk) {
        if (isEnded) {
          // Drain out the remaining data, even if it's not a 'chunkSize'.
          return Option.some(drainOutQueue())
        } else {
          // Wait until we have enough data to emit a full chunk.
          return Option.none()
        }
      }

      const prefixChunks = queue.splice(0, bufferedPrefix.count)

      const criticalChunk = queue[0]

      // Divide the critical chunk into: left part that completes the multiple &
      // right part that is the remainder.
      const leftCriticalChunk = criticalChunk.subarray(0, emitChunkSize - bufferedPrefix.sizeSum)
      const rightCriticalChunk = criticalChunk.subarray(emitChunkSize - bufferedPrefix.sizeSum)

      // Shrink or remove the critical chunk
      if (rightCriticalChunk.length > 0) {
        queue[0] = rightCriticalChunk
      } else {
        queue.shift()
      }

      resetBufferedPrefix()

      return Option.some(mergeBuffers([...prefixChunks, leftCriticalChunk]))
    },
  }
}

/**
 * Create a TransformStream out of a ChaCha20Cipher.
 */
export function createBufferChunkerTransformStream(chunkSize: number): TransformStream<Uint8Array> {
  const chunker = createBufferChunker(chunkSize)

  const flush = (controller: TransformStreamDefaultController<Uint8Array<ArrayBufferLike>>) => {
    while (true) {
      const outChunkMaybe = chunker.pull()
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
      chunker.push(inChunk)
      flush(controller)
    },
    flush: async (controller) => {
      chunker.end()
      flush(controller)
    }
  })
}

