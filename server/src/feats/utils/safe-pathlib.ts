import pathlib from "path"

/**
 * Safely join a base directory with a more specific path.
 * 
 * Throws when attempting to escape the base directory
 */
export function safeJoinPath(baseDir: string, morePath: string) {
  const resolvedBase = pathlib.resolve(baseDir)
  const joinedPath = pathlib.resolve(pathlib.join(resolvedBase, morePath))

  if (!joinedPath.startsWith(resolvedBase)) {
    throw new Error(`safe_join_path: Cannot join '${morePath}' to '${baseDir}' as it escapes the base directory`)
  }

  return joinedPath
}