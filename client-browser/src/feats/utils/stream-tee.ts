
export function createTeeTransformStream(callback: (chunk: Uint8Array) => void): TransformStream<Uint8Array> {
  return new TransformStream<Uint8Array>({
    transform(chunk, controller) {
      callback(chunk)
      controller.enqueue(chunk)
    }
  })
}

export function createAsyncTeeTransformStream(callback: (chunk: Uint8Array) => Promise<void>): TransformStream<Uint8Array> {
  return new TransformStream<Uint8Array>({
    async transform(chunk, controller) {
      await callback(chunk)
      controller.enqueue(chunk)
    }
  })
}
