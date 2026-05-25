/**
 * A synchronous mailbox (actor). Commands are enqueued via `send(cmd)` and
 * processed one-at-a-time by a microtask-driven worker loop.
 */
export function createActor<Cmd>(handler: (cmd: Cmd) => void) {
  const queue: Cmd[] = []
  let running = false

  function process(): void {
    running = true
    while (queue.length > 0) {
      const cmd = queue.shift()!
      handler?.(cmd)
    }
    running = false
  }

  function schedule(): void {
    if (!running) queueMicrotask(process)
  }

  return {
    send(cmd: Cmd): void {
      queue.push(cmd)
      schedule()
    },
  }
}
