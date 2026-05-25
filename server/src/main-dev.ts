import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import fs from "fs"
import { createSecureServer } from 'http2'
import { LogAction } from './feats/utils/colog.js'
import { FileStoreWorkerAPI } from './feats/file-store/worker-api.js'
import { Db } from './feats/file-store/db.js'
import { createHonoServer } from './feats/server-core/create-hono.js'

/* ═══════════════════════════════════════════════════════════════════════════
 * Dev server — edit the params below to suit your local setup.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── Tunables ───────────────────────────────────────────────────────────────
const STORE_SIZE = 10 * 1024 * 1024 * 1024      // 10 GB
const FILE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024  // 2 GB
const MIN_EXPIRE_DURATION = 120                // 2 minutes
const MAX_EXPIRE_DURATION = 99999999            // Basically infinite
const DB_PATH = "./dev/db.sqlite3"
const FILES_DIR = "./dev/files"
const CLEANUP_MS = 60_000
const HOSTNAME = "127.0.0.1"
const PORT = 3000

/*
 * Uses HTTPS (dev certs from `./dev/*.pem`) because browser security policies
 * require a secure context for some APIs (e.g. crypto.subtle) in local dev.
 *
 * You have to set these up yourself with mkcert, etc.
 */
const TLS_KEY_PATH = "./dev/mkcert-key.pem"
const TLS_CERT_PATH = "./dev/mkcert.pem"

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function main() {
  const appLogger = LogAction.createBasicLogAction("App")

  const db = Db.create(DB_PATH)

  const fileStore = await FileStoreWorkerAPI.bootup({
    logger: LogAction.createBasicLogAction("FileStore"),
    maxAllocSize: STORE_SIZE,
    maxFileSize: FILE_SIZE_LIMIT,
    minExpireDuration: MIN_EXPIRE_DURATION,
    maxExpireDuration: MAX_EXPIRE_DURATION,
    filesDir: FILES_DIR,
    db,
  })

  const cleanupTimer = setInterval(() => {
    void fileStore.cleanupExpired()
  }, CLEANUP_MS)

  const app = new Hono()
  app.use('/api/*', cors())
  createHonoServer(app, fileStore, appLogger)

  serve({
    fetch: app.fetch,
    hostname: HOSTNAME,
    port: PORT,
    createServer: createSecureServer,

    /* HTTPS is required to bypass browser security restrictions. */
    serverOptions: {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
    },
  }, (info) => {
    console.log(`Dev server running on https://${info.address}:${info.port}`)
  })

  process.on("SIGINT", () => { clearInterval(cleanupTimer); process.exit(0) })
  process.on("SIGTERM", () => { clearInterval(cleanupTimer); process.exit(0) })
}

main()
