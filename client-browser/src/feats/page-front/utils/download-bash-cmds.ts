import { VITE_DEFAULT_API_URL } from "@/feats/env-config/env-config"
import { uint8ArrayToHex } from "@/feats/utils/hex"

export function downloadBashCmds(opts: { fileID: string; fileName: string; key: Uint8Array; hash: Uint8Array }) {
  const base = `${VITE_DEFAULT_API_URL}/download/${opts.fileID}`
  const keyHex = uint8ArrayToHex(opts.key)
  const hashHex = uint8ArrayToHex(opts.hash)

  const curl = [
    `curl -fsSL '${base}' | \\`,
    `  openssl enc -chacha20 -d -K '${keyHex}' -iv 00000000000000000000000000000000 -out '${opts.fileName}' && \\`,
    `  echo "${hashHex}  ${opts.fileName}" | \\`,
    `  sha256sum --check`,
  ].join("\n")

  const wget = [
    `wget -O - '${base}' | \\`,
    `  openssl enc -chacha20 -d -K '${keyHex}' -iv 00000000000000000000000000000000 -out '${opts.fileName}' && \\`,
    `  echo "${hashHex}  ${opts.fileName}" | \\`,
    `  sha256sum --check`,
  ].join("\n")

  return { curl, wget }
}
