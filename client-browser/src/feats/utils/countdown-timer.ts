
export interface CountdownTimer {
  set(timeoutMs: number, action: () => void): void
  clear(): void
}

export function createCountdownTimer(): CountdownTimer {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let activeTicket: number = 0

  const ensureClearTimeout = () => {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)

      /*
       * Invalidates any pending timeout actions. Also gives a fresh ticket for
       * next set() call.
       */
      activeTicket += 1
    }
  }

  return {
    set(timeoutMs, action) {
      ensureClearTimeout()

      const thisTicket = activeTicket

      timeoutHandle = setTimeout(() => {
        /* To reduce race condition even more */
        if (activeTicket !== thisTicket) {
          return
        }

        action()
      }, timeoutMs)
    },
    clear() {
      ensureClearTimeout()
    }
  }
}
