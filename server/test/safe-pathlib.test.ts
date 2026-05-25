import { describe, it, expect } from "vitest"
import path from "path"
import { safeJoinPath } from "../src/feats/utils/safe-pathlib.js"

describe("safeJoinPath", () => {
  const base = "/data/files"

  it("joins a simple filename", () => {
    const result = safeJoinPath(base, "foo.dat")
    expect(result).toBe(path.resolve("/data/files/foo.dat"))
  })

  it("joins into a subdirectory", () => {
    const result = safeJoinPath(base, "sub/bar.dat")
    expect(result).toBe(path.resolve("/data/files/sub/bar.dat"))
  })

  it("resolves '.' to the base directory itself", () => {
    const result = safeJoinPath(base, ".")
    expect(result).toBe(path.resolve("/data/files"))
  })

  it("handles nested path with extra slashes", () => {
    const result = safeJoinPath(base, "//a//b//")
    expect(result).toBe(path.resolve("/data/files/a/b"))
  })

  it("throws on simple parent traversal", () => {
    expect(() => safeJoinPath(base, "..")).toThrow()
  })

  it("throws on deep parent traversal", () => {
    expect(() => safeJoinPath(base, "../../../etc/passwd")).toThrow()
  })

  it("treats absolute path argument as a nested relative path (path.join behaviour)", () => {
    const result = safeJoinPath(base, "/etc/passwd")
    expect(result).toBe(path.resolve("/data/files/etc/passwd"))
  })

  it("throws on traversal via encoded-looking path", () => {
    expect(() => safeJoinPath(base, "sub/../../etc")).toThrow()
  })

  it("throws on traversal from nested directory", () => {
    expect(() => safeJoinPath(base, "sub/../..")).toThrow()
  })

  it("works with relative base dir", () => {
    const rel = "relative/path"
    const result = safeJoinPath(rel, "file.txt")
    expect(result).toBe(path.resolve("relative/path/file.txt"))
  })

  it("works with trailing slash in base", () => {
    const result = safeJoinPath("/data/files/", "file.txt")
    expect(result).toBe(path.resolve("/data/files/file.txt"))
  })
})
