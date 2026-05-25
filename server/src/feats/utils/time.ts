
/**
 * Returns the current timestamp in seconds (as a float) since the Unix epoch.
 */
export function getCurrentTimestamp(): number {
  return Date.now() / 1000
}