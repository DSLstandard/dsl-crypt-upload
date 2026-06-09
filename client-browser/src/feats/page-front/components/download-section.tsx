import { useEffect, useMemo, useState } from "react"
import StreamSaver from "streamsaver"
import { Option } from "effect"
import { hexToUint8Array, uint8ArrayToHex } from "../../utils/hex"
import { CHACHA20_KEY_NBYTES } from "../../utils/stream-chacha20-cipher"
import { SHA256_HASH_NBYTES } from "../../utils/stream-sha256-hasher"
import { downloadFile, type DownloadParams, type DownloadResult } from "../utils/download-file"
import { Spinner } from "@/components/ui/spinner"
import { CommandBlock } from "./command-block"
import { QrCodeDialog } from "../../ui-components/qr-code-dialog"
import { Button } from "@/components/ui/button"
import { DownloadIcon, QrCode, X, TriangleAlert } from "lucide-react"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { downloadBashCmds } from "../utils/download-bash-cmds"

/* ── URL parsing ───────────────────────────────────────────────────────── */

function parseUrl(input: string): { ok: true; params: DownloadParams } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { ok: false, reason: "Invalid URL" }
  }

  const q = url.searchParams
  const fileName = q.get("file-name")
  const fileID = q.get("file-id")
  const hashHex = q.get("hash")
  const keyHex = q.get("key")

  if (!fileName || !fileID || !hashHex || !keyHex) {
    return { ok: false, reason: "Missing parameters" }
  }

  const hash = hexToUint8Array(hashHex)
  if (Option.isNone(hash) || hash.value.length !== SHA256_HASH_NBYTES) {
    return { ok: false, reason: "Invalid hash" }
  }

  const key = hexToUint8Array(keyHex)
  if (Option.isNone(key) || key.value.length !== CHACHA20_KEY_NBYTES) {
    return { ok: false, reason: "Invalid key" }
  }

  return { ok: true, params: { fileName, fileID, hash: hash.value, key: key.value } }
}

/* ── Component ─────────────────────────────────────────────────────────── */

export function DownloadSection() {
  const [input, setInput] = useState("")
  const [downloading, setDownloading] = useState(false)
  const [result, setResult] = useState<DownloadResult | null>(null)

  const parsed = useMemo(() => (input.trim() ? parseUrl(input) : null), [input])
  const params = parsed?.ok ? parsed.params : null

  /* On mount, if the URL has shareable params, pre-fill input and clean URL */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const fileName = q.get("file-name")
    const fileID = q.get("file-id")
    const hashHex = q.get("hash")
    const keyHex = q.get("key")

    if (fileName && fileID && hashHex && keyHex) {
      const url = `${window.location.origin}${window.location.pathname}?${q.toString()}`
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInput(url)
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [])

  const cmds = params ? downloadBashCmds({ fileID: params.fileID, fileName: params.fileName, key: params.key, hash: params.hash }) : null

  const startDownload = async () => {
    if (!params) return
    setDownloading(true)
    setResult(null)

    StreamSaver.mitm = "/jimmywarting_streamsaver/mitm.html"
    const writeStream = StreamSaver.createWriteStream(params.fileName, { size: 0 })
    const r = await downloadFile(params, writeStream)
    setResult(r)
    setDownloading(false)
  }

  return (
    <section className="px-4">
      <h2 className="mb-4 font-bold">Download</h2>

      <div className="mb-2 flex items-center gap-1">
        <input
          type="text"
          placeholder="Paste shareable URL"
          value={input}
          onChange={(e) => { setInput(e.target.value); setResult(null) }}
          className="min-w-0 flex-1 border border-gray-300 px-3 py-2 text-sm outline-none focus:border-sky-500"
        />
        <QrCodeDialog url={input.trim()}>
          <Button disabled={params === null} variant="outline" size="icon" className="shrink-0 border-gray-300">
            <QrCode className="size-4" />
          </Button>
        </QrCodeDialog>
        <Button
          disabled={input.length === 0}
          variant="outline"
          size="icon"
          className="shrink-0 border-gray-300"
          onClick={() => { setInput(""); setResult(null) }}
        >
          <X className="size-4" />
        </Button>
      </div>

      {parsed && !parsed.ok && (
        <p className="mt-1 text-xs text-red-500">{parsed.reason}</p>
      )}

      {params && (
        <ul className="mt-2 space-y-0.5 text-xs text-gray-500">
          <li className="flex items-center gap-1 overflow-x-auto">
            <span className="shrink-0 font-bold text-gray-500">File Name:</span>
            <span className="whitespace-pre underline text-blue-500">{params.fileName}</span>
          </li>
          <li className="flex items-center gap-1 overflow-x-auto">
            <span className="shrink-0 font-bold text-gray-500">File ID:</span>
            <span className="whitespace-pre text-gray-500">{params.fileID}</span>
          </li>
          <li className="flex items-center gap-1 overflow-x-auto">
            <span className="shrink-0 font-bold text-gray-500">Key:</span>
            <span className="whitespace-pre text-gray-500">{uint8ArrayToHex(params.key)}</span>
          </li>
          <li className="flex items-center gap-1 overflow-x-auto">
            <span className="shrink-0 font-bold text-gray-500">Hash:</span>
            <span className="whitespace-pre text-gray-500">{uint8ArrayToHex(params.hash)}</span>
          </li>
        </ul>
      )}

      <button
        onClick={startDownload}
        disabled={downloading || !params}
        className="mt-2 shrink-0 bg-sky-600 px-4 py-2 text-sm font-medium text-white w-full flex justify-center items-center gap-x-1 hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {downloading ? <Spinner /> : <DownloadIcon className="size-4" />}
        <div>Download</div>
      </button>

      {result?.tag === "ok" && (
        <p className="mt-2 text-xs text-green-600">Downloaded and SHA-256 hash verified.</p>
      )}

      {result?.tag === "hash-mismatch" && (
        <Alert variant="destructive" className="mt-2 bg-red-100 border-red-400">
          <TriangleAlert />
          <AlertTitle>
            FILE INTEGRITY VERIFICATION FAILED
          </AlertTitle>
          <AlertDescription className="overflow-x-hidden">
            <p>
              The downloaded file does not match the expected hash. The file may be corrupted, tampered with (by the server hoster), or malicious.
            </p>
            <p>
              YOU SHOULD DELETE THE FILE. DO NOT USE THIS FILE.
            </p>
            <div className="overflow-x-auto text-nowrap">
              Computed hash: {result.got}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {result?.tag === "error" && (
        <p className="mt-2 text-xs text-red-500">{result.message}</p>
      )}

      {cmds && (
        <div className="mt-4 space-y-3">
          <CommandBlock label="curl" command={cmds.curl} />
          <CommandBlock label="wget" command={cmds.wget} />
        </div>
      )}
    </section>
  )
}
