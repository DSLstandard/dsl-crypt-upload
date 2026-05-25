import { randomInt } from "./random.js"

const POOL = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

export function generateAlnumChar(): string {
  const i = randomInt(0, POOL.length)
  return POOL[i]
}

export function generateAlnumString(len: number): string {
  let buf = ""
  for (let i = 0; i < len; i++) {
    buf += generateAlnumChar()
  }
  return buf
}

export function isAlnumString(str: string): boolean {
  for (const char of str) {
    if (!POOL.includes(char)) {
      return false
    }
  }
  return true
}