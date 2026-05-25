import { AsyncQueue, Deferred } from "@esfx/async";
import Denque from "denque";

/**
 * Haskell's MVar but in TypeScript
 */
export class AsyncMVar<T> {
  private takers: Denque<{ onPut: Deferred<T> }>
  private putters: Denque<{ value: T, onTaken: Deferred<void> }>

  constructor() {
    this.takers = new Denque()
    this.putters = new Denque()
  }

  async put(value: T): Promise<void> {
    const taker = this.takers.shift()
    if (taker) {
      taker.onPut.resolve(value)
    } else {
      const onTaken = new Deferred<void>()
      this.putters.push({ value, onTaken })
      await onTaken
    }
  }

  async take(): Promise<T> {
    const putter = this.putters.shift()
    if (putter) {
      const x = putter.value
      putter.onTaken.resolve()
      return x
    } else {
      const onPut = new Deferred<T>()
      this.takers.push({ onPut })
      return await onPut.promise
    }
  }
}

export type AsyncSignal = AsyncMVar<void>
