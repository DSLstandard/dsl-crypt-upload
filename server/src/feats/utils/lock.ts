import type { AsyncMutex } from "@esfx/async";

/* ── Existing UseAsyncMutexTransaction (kept for sessLock usage) ───────── */

export interface UseAsyncMutexTransaction {
  unlockNow: () => void
  [Symbol.dispose]: () => void
}

export async function useAsyncMutex(mutex: AsyncMutex): Promise<UseAsyncMutexTransaction> {
  let wasUnlocked = false
  const lockHandle = await mutex.lock()

  return {
    unlockNow: () => {
      if (wasUnlocked) {
        throw new Error("Mutex already unlocked")
      }
      lockHandle.unlock()
      wasUnlocked = true
    },
    [Symbol.dispose]: () => {
      if (!wasUnlocked) {
        lockHandle.unlock()
      }
    }
  }
}

/* ── AsyncLockProof: type-level witness that a lock is held ───────────── */

/**
 * A proof that a mutex is currently held by the caller.
 *
 * Acquire one via {@link acquireMutex}, then pass it to any function that
 * documents "requires stateLock proof".  The proof validates at runtime that
 * it hasn't been released yet, catching double-release programming errors.
 *
 * Usage:
 * ```
 * const proof = await acquireMutex(someMutex)
 * using _proof = proof     // auto-release on scope exit
 *
 * someFunctionThatNeedsLock(proof)
 * proof.release()          // early unlock (optional)
 * ```
 */
export class AsyncLockProof {
  private released = false
  private handle: { unlock(): void }

  constructor(handle: { unlock(): void }) {
    this.handle = handle
  }

  /**
   * Assert this proof is still valid.
   *
   * Throws if the lock was already released (either via `release()` or
   * `[Symbol.dispose]()`).  Call this at the top of any function that
   * receives a proof to catch callers passing a stale witness.
   */
  ensure(): void {
    if (this.released) {
      throw new Error("AsyncLockProof: lock was already released")
    }
  }

  /**
   * Release the underlying mutex early.
   *
   * After this call the proof is invalid — any future `ensure()` will throw.
   * Idempotent: calling again is harmless.
   */
  release(): void {
    if (!this.released) {
      this.released = true
      this.handle.unlock()
    }
  }

  /** `using` support: auto-release on scope exit. */
  [Symbol.dispose](): void {
    this.release()
  }
}

/**
 * Acquire an AsyncMutex and return an {@link AsyncLockProof}.
 *
 * The proof is a disposable that auto-releases the mutex when the scope ends.
 */
export async function acquireMutex(mutex: AsyncMutex): Promise<AsyncLockProof> {
  const handle = await mutex.lock()
  return new AsyncLockProof(handle)
}
