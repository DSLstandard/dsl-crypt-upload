
export function unreachable(proof: never): never {
  throw new Error(`Reached unreachable code with value: ${proof}`)
}