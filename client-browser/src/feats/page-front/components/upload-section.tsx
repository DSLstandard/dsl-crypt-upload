import { useRef, useState } from "react"
import { FileUp, Server } from "lucide-react"
import { toast } from "sonner"
import { useQuery } from "@tanstack/react-query"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { generateChaCha20Key } from "../../utils/stream-chacha20-cipher"
import { uint8ArrayToHex } from "../../utils/hex"
import { uploadFile } from "../utils/upload-file"
import { CommandBlock } from "./command-block"
import { VITE_DEFAULT_API_URL } from "../../env-config/env-config"
import { downloadBashCmds } from "../utils/download-bash-cmds"
import { serverSettingsInfo } from "../utils/server-settings-api"
import { Input } from "@/components/ui/input"

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function fmtDuration(seconds: number): string {
  return `${seconds}s`
}

const EXPIRE_PRESETS = [
  { label: "2 min", seconds: 120 },
  { label: "5 min", seconds: 300 },
  { label: "15 min", seconds: 900 },
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86400 },
]

function makeShareableUrl(opts: { fileID: string; fileName: string; hash: Uint8Array; key: Uint8Array }): string {
  const q = new URLSearchParams()
  q.set("file-name", opts.fileName)
  q.set("file-id", opts.fileID)
  q.set("hash", uint8ArrayToHex(opts.hash))
  q.set("key", uint8ArrayToHex(opts.key))
  return `${window.location.origin}${window.location.pathname}?${q.toString()}`
}

/* ── State machine ─────────────────────────────────────────────────────── */

/** Idle — no file selected. Shows file picker button + CLI shell script block. */
type UploadStateIdle = { tag: "idle" }

/** File picked but not uploading yet. Shows file info, expiration slider, upload button. */
type UploadStateSelected = { tag: "selected"; file: File }

/** Upload in progress. Shows progress bar. */
type UploadStateUploading = { tag: "uploading"; file: File; key: Uint8Array; nbytesUploaded: number }

/** Upload complete. Shows shareable URL + CLI download commands. */
type UploadStateDone = { tag: "done"; fileName: string; key: Uint8Array; fileID: string; hash: Uint8Array; url: string }

/** Upload failed. Shows error message + retry controls. */
type UploadStateError = { tag: "error"; file: File; errorMessage: string }

type UploadState = UploadStateIdle | UploadStateSelected | UploadStateUploading | UploadStateDone | UploadStateError

/* ── Upload Section ────────────────────────────────────────────────────── */

export function UploadSection() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<UploadState>({ tag: "idle" })
  const [expireDuration, setExpireDuration] = useState(120)

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    if (f && f.size === 0) return
    if (f) {
      setState({ tag: "selected", file: f })
    }
  }

  const startUpload = async () => {
    if (state.tag !== "selected" && state.tag !== "error") return
    const { file } = state
    const key = generateChaCha20Key()

    setState({ tag: "uploading", file, key, nbytesUploaded: 0 })

    const r = await uploadFile(file, key, (b) => {
      setState({ tag: "uploading", file, key, nbytesUploaded: b })
    }, expireDuration)

    if (r.tag === "ok") {
      setState({
        tag: "done",
        fileName: file.name,
        key,
        fileID: r.fileID,
        hash: r.hash,
        url: makeShareableUrl({ fileID: r.fileID, fileName: file.name, hash: r.hash, key }),
      })
      if (inputRef.current) inputRef.current.value = ""
    } else {
      setState({ tag: "error", file, errorMessage: r.message })
    }
  }

  return (
    <section className="px-4">
      <h2 className="mb-4 font-bold">Upload</h2>

      <input ref={inputRef} type="file" className="hidden" onChange={onPick} />

      <ServerInfoSection />

      {/* State 1: idle */}
      {state.tag === "idle" && (() => {

        return (
          <div className="space-y-4">
            <button
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 border-2 border-dashed border-gray-300 p-8 hover:border-sky-400 cursor-pointer"
            >
              <FileUp className="size-8 text-sky-600" />
              <span className="text-sm text-gray-500">Select a file to upload</span>
            </button>

            <CommandBlock label="Shell script for upload" command={makeUploadShellScript()} />
          </div>
        )
      })()}

      {/* State 2: selected */}
      {state.tag === "selected" && (
        <div className="space-y-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full cursor-pointer border border-dashed border-gray-300 p-3 text-left text-sm font-medium hover:border-sky-400"
          >
            {state.file.name} — {fmtSize(state.file.size)}<br />
            <span className="text-xs font-normal text-gray-400">Click to change file</span>
          </button>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>Expiration (seconds)</span>
              <span>{fmtDuration(expireDuration)}</span>
            </div>

            <div className="flex flex-wrap gap-1">
              {EXPIRE_PRESETS.map((p) => (
                <button
                  key={p.seconds}
                  type="button"
                  onClick={() => setExpireDuration(p.seconds)}
                  className={"px-2 py-1 text-xs border rounded cursor-pointer " + (expireDuration === p.seconds ? "bg-sky-600 text-white border-sky-600" : "bg-white text-gray-600 border-gray-300 hover:border-sky-400")}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <Input
              type="number"
              min={1}
              value={expireDuration}
              onChange={(e) => setExpireDuration(Math.max(1, Number(e.target.value) || 1))}
              className="rounded-none"
            />
          </div>

          <button
            onClick={startUpload}
            className="w-full bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            Upload file
          </button>
        </div>
      )}

      {/* State 3: uploading */}
      {state.tag === "uploading" && (
        <div className="space-y-3">
          <p className="text-sm font-medium">{state.file.name} — {fmtSize(state.file.size)}</p>
          <button
            disabled
            className="w-full bg-sky-600 px-4 py-2 text-sm font-medium text-white opacity-60"
          >
            Uploading…
          </button>
          <div>
            <Progress value={Math.min(Math.round((state.nbytesUploaded / state.file.size) * 100), 100)} />
            <p className="mt-1 text-right text-xs text-gray-400">
              {fmtSize(state.nbytesUploaded)} / {fmtSize(state.file.size)}
            </p>
          </div>
        </div>
      )}

      {/* State 4: error */}
      {state.tag === "error" && (
        <div className="space-y-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full cursor-pointer border border-dashed border-gray-300 p-3 text-left text-sm font-medium hover:border-sky-400"
          >
            {state.file.name} — {fmtSize(state.file.size)}<br />
            <span className="text-xs font-normal text-gray-400">
              [Click to retry with a different file]
            </span>
          </button>

          <p className="text-xs text-red-500">
            Upload error: {state.errorMessage}
          </p>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>Expiration (seconds)</span>
              <span>{fmtDuration(expireDuration)}</span>
            </div>

            <div className="flex flex-wrap gap-1">
              {EXPIRE_PRESETS.map((p) => (
                <button
                  key={p.seconds}
                  type="button"
                  onClick={() => setExpireDuration(p.seconds)}
                  className={"px-2 py-1 text-xs border rounded cursor-pointer " + (expireDuration === p.seconds ? "bg-sky-600 text-white border-sky-600" : "bg-white text-gray-600 border-gray-300 hover:border-sky-400")}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <input
              type="number"
              min={1}
              value={expireDuration}
              onChange={(e) => setExpireDuration(Math.max(1, Number(e.target.value) || 1))}
              className="w-full border border-gray-300 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
          </div>

          <button
            onClick={startUpload}
            className="w-full bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            Retry upload
          </button>
        </div>
      )}

      {/* State 5: done */}
      {state.tag === "done" && (() => {
        const cmds = downloadBashCmds({
          fileID: state.fileID,
          fileName: state.fileName,
          key: state.key,
          hash: state.hash,
        })

        return (
          <div className="space-y-3">
            <div className="border border-green-300 bg-green-50 p-3 text-sm">
              <div className="font-medium text-green-800">
                Upload complete!
                <span
                  onClick={() => {
                    navigator.clipboard.writeText(state.url); toast.success("Copied!")
                  }}
                  className="underline underline-offset-2 cursor-pointer ml-1"
                >(Click to copy URL)</span>
                <span
                  onClick={() => {
                    if (navigator.share) {
                      navigator.share({ url: state.url })
                    } else {
                      toast.error("Share not supported on this browser/device")
                    }
                  }}
                  className="underline underline-offset-2 cursor-pointer ml-1"
                >(Click to share)</span>
              </div>
              <p className="mt-1 min-w-0 break-all font-mono text-green-700">{state.url}</p>
            </div>

            <button
              onClick={() => setState({ tag: "idle" })}
              className="mt-2 shrink-0 bg-sky-600 px-4 py-2 text-sm font-medium text-white w-full flex justify-center items-center gap-x-1 hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Upload another file
            </button>

            <CommandBlock label="curl" command={cmds.curl} />
            <CommandBlock label="wget" command={cmds.wget} />
          </div>
        )
      })()}
    </section>
  )
}

function makeUploadShellScript() {
  const baseUrl = VITE_DEFAULT_API_URL
  const script = [
    `sh -s -- ./YOUR_FILE_HERE <<'SCRIPT'`,
    ``,
    `set -eu`,
    ``,
    `clear`,
    `echo "=== DSL Crypt Upload ==="`,
    ``,
    `API_URL="${baseUrl}"`,
    `FRONTEND_URL="${window.location.origin}"`,
    ``,
    `[ $# -ge 1 ] || { echo "Usage: sh -s -- <file-to-upload> [expire-seconds]" >&2; exit 1; }`,
    ``,
    `FILE="$1"`,
    `[ -f "$FILE" ] || { echo "Error: file not found: $FILE" >&2; exit 1; }`,
    ``,
    `KEY=$(openssl rand -hex 32)`,
    `HASH=$(sha256sum "$FILE" | cut -d' ' -f1)`,
    `SIZE=$(stat -c%s "$FILE")`,
    `EXPIRE_SECONDS="\${2:-120}" # Defaults to 2 minutes (120s) if not provided`,
    ``,
    `echo "File: $FILE"`,
    `echo "Size: $SIZE bytes"`,
    `echo "Key:  $KEY"`,
    `echo "Hash: $HASH"`,
    `echo "Expires in: \${EXPIRE_SECONDS}s"`,
    ``,
    `echo`,
    `echo "--- Encrypting & Uploading ---"`,
    `set +e`,
    `RESPONSE=$(openssl enc -chacha20 -e -K "$KEY" -iv 00000000000000000000000000000000 -in "$FILE" | \\`,
    `  curl --fail-with-body -X POST "$API_URL/upload/oneshot?expireInSeconds=$EXPIRE_SECONDS" \\`,
    `  -H "Content-Type: application/octet-stream" \\`,
    `  -H "Content-Length: $SIZE" \\`,
    `  --data-binary @-)`,
    `UPLOAD_RESULT=$?`,
    `set -e`,
    `[ "$UPLOAD_RESULT" -eq 0 ] || { echo "\n[File upload error] upload failed. Server responded with: $RESPONSE" >&2; exit 1; }`,
    ``,
    `FILE_ID=$(echo "$RESPONSE" | jq -r '.fileId')`,
    `[ -n "$FILE_ID" ] || { echo "Error: upload failed - $RESPONSE" >&2; exit 1; }`,
    ``,
    `echo`,
    `echo "--- File upload completed ---"`,
    `echo "File ID: $FILE_ID"`,
    ``,
    `echo`,
    `echo "--- Shareable URL for browsers ---"`,
    `echo "$FRONTEND_URL?file-name=$(basename "$FILE")&file-id=$FILE_ID&hash=$HASH&key=$KEY"`,
    ``,
    `echo`,
    `echo "--- Download command (run on another machine) ---"`,
    `echo "curl --fail-with-body -sSL \\"$API_URL/download/$FILE_ID\\" | \\\\"`,
    `echo "  openssl enc -chacha20 -d -K \\"$KEY\\" \\\\"`,
    `echo "    -iv 00000000000000000000000000000000 \\\\"`,
    `echo "    -out \\"$(basename "$FILE")\\" && \\\\"`,
    `echo "  echo \\"$HASH  $(basename "$FILE")\\" | sha256sum --check"`,
    `echo ""`,
    `echo "=== done ==="`,
    `SCRIPT`,
  ].join("\n")
  return script
}

function ServerInfoSection() {
  const settingsQuery = useQuery(serverSettingsInfo())

  return (
    <section className="mb-4">
      <h1 className="mb-1 font-bold text-sm">
        <Server className="inline-block mr-2 w-4 h-4 text-gray-600" />
        File Server Constraints
      </h1>
      <p className="mb-2 text-xs text-gray-500">
        You must follow these constraints when uploading files. Server would otherwise reject your upload.
      </p>
      {settingsQuery.isPending && (
        <p className="text-xs text-gray-400">Loading server settings…</p>
      )}
      {settingsQuery.isError && (
        <p className="text-xs text-red-400">Server info unavailable: {settingsQuery.error.message}</p>
      )}
      {settingsQuery.isSuccess && (
        <Table className="text-xs">
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Server's available space</TableCell>
              <TableCell>{"[Undisclosed]"}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Max file size</TableCell>
              <TableCell>{fmtSize(settingsQuery.data.maxFileSize)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Min expiration</TableCell>
              <TableCell>{fmtDuration(settingsQuery.data.minExpireDuration)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Max expiration</TableCell>
              <TableCell>{fmtDuration(settingsQuery.data.maxExpireDuration)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </section>
  )
}
