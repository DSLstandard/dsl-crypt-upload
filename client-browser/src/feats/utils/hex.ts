import { Option } from "effect";

export function byteToHex(byte: number) {
  return byte.toString(16).padStart(2, '0');
}

export function uint8ArrayToHex(data: Uint8Array): string {
  let str = ""

  for (const byte of data) {
    str += byteToHex(byte)
  }

  return str
}

export function hexToUint8Array(hexString: string): Option.Option<Uint8Array> {
  if (hexString.length % 2 !== 0) {
    return Option.none()
  }

  const bytes = new Uint8Array(hexString.length / 2)

  for (let i = 0; i < bytes.length; i++) {
    const hexByte = hexString.slice(i * 2, i * 2 + 2)
    const byte = parseInt(hexByte, 16)

    if (Number.isNaN(byte)) {
      return Option.none()
    }

    bytes[i] = byte
  }

  return Option.some(bytes)
}

