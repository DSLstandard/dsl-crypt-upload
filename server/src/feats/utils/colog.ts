
/** Like Haskell's colog's LogAction */
export interface LogAction<I> {
  log: (input: I) => void
}

export interface RichMessage {
  level: string
  message: string
}

export const DEBUG = "DEBUG"
export const INFO = "INFO"
export const WARN = "WARN"
export const ERROR = "ERROR"

export namespace LogAction {
  export function createBasicLogAction(name: string): LogAction<RichMessage> {
    return {
      log: ({ level, message }) => {
        const timestamp = new Date().toISOString()
        console.log(`${timestamp} (${name}/${level}) ${message}`)
      }
    }
  }
}
