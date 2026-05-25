export function randomInt(low: number, highExclusive: number): number {
  return low + Math.floor(Math.random() * (highExclusive - low))
}

export function randomPickArray<T>(arr: T[]): T {
  if (arr.length === 0) {
    throw new Error("Cannot pick from an empty array")
  }

  return arr[randomInt(0, arr.length)]
}
