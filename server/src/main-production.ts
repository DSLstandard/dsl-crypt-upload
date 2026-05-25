import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import fs from "fs"
import { LogAction } from './feats/utils/colog.js'
import { FileStoreWorkerAPI } from './feats/file-store/worker-api.js'
import { Db } from './feats/file-store/db.js'
import { createHonoServer } from './feats/server-core/create-hono.js'

/* ── Config ───────────────────────────────────────────────────────────── */

interface ServerConfig {
  /** Max aggregate bytes across all active uploads */
  storeSize: number
  /** Max bytes for a single file */
  fileSizeLimit: number
  /** Min allowed expire duration in seconds (from now). Optional, defaults to 120. */
  minExpireDuration?: number
  /** Max allowed expire duration in seconds (from now) */
  maxExpireDuration: number
  /** Path to SQLite database file */
  dbPath: string
  /** Directory for storing files (seeding/ + uploading/ subdirs) */
  filesDir: string
  /** Cleanup interval in milliseconds */
  cleanupIntervalMs: number
  /** Hostname to bind to */
  hostname: string
  /** HTTP port (TLS is handled by a reverse proxy, e.g. nginx) */
  port: number
}

function loadConfig(filePath: string): ServerConfig {
  const raw = fs.readFileSync(filePath, "utf-8")
  const obj = JSON.parse(raw) as Partial<ServerConfig>

  const required: (keyof ServerConfig)[] = [
    "storeSize",
    "fileSizeLimit",
    "maxExpireDuration",
    "dbPath",
    "filesDir",
    "cleanupIntervalMs",
    "hostname",
    "port",
  ]
  for (const key of required) {
    if (obj[key] === undefined) {
      throw new Error(`Missing required config field: ${key}`)
    }
  }

  return obj as ServerConfig
}

/* ── Bootstrap ────────────────────────────────────────────────────────── */

async function main() {
  const configPath = process.argv[2] ?? "./config.json"
  const config = loadConfig(configPath)

  const appLogger = LogAction.createBasicLogAction("App")

  const db = Db.create(config.dbPath)

  const fileStore = await FileStoreWorkerAPI.bootup({
    logger: LogAction.createBasicLogAction("FileStore"),
    maxAllocSize: config.storeSize,
    maxFileSize: config.fileSizeLimit,
    minExpireDuration: config.minExpireDuration ?? 120,
    maxExpireDuration: config.maxExpireDuration,
    filesDir: config.filesDir,
    db,
  })

  const cleanupTimer = setInterval(() => {
    void fileStore.cleanupExpired()
  }, config.cleanupIntervalMs)

  const app = new Hono()
  app.use('/api/*', cors())
  createHonoServer(app, fileStore, appLogger)

  // Plain HTTP — TLS is handled by a reverse proxy (nginx, Caddy, etc.).
  serve({
    fetch: app.fetch,
    hostname: config.hostname,
    port: config.port,
  }, (info) => {
    console.log(`Production server running on http://${info.address}:${info.port}`)
  })

  process.on("SIGINT", () => { clearInterval(cleanupTimer); process.exit(0) })
  process.on("SIGTERM", () => { clearInterval(cleanupTimer); process.exit(0) })
}

main()
