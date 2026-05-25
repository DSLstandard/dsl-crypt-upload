
export function unreachable(proof: never) {
  throw new Error(`Unreachable code reached with value: ${proof}`)
}