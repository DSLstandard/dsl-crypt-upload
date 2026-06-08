import crypto from "crypto"

const POOL = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

export function securelyGenerateAlnumChar(): string {
  return POOL[crypto.randomInt(0, POOL.length)]
}

export function securelyGenerateAlnumString(len: number): string {
  let buf = ""
  for (let i = 0; i < len; i++) {
    buf += securelyGenerateAlnumChar()
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