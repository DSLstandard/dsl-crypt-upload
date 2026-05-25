import { VITE_DEFAULT_API_URL } from "@/feats/env-config/env-config"
import { queryOptions } from "@tanstack/react-query"

export interface ServerInfo {
  maxFileSize: number
  minExpireDuration: number
  maxExpireDuration: number
}

export function serverSettingsInfo() {
  return queryOptions({
    queryKey: ["serverSettingsInfo", VITE_DEFAULT_API_URL],
    queryFn: async (): Promise<ServerInfo> => {
      const response = await fetch(`${VITE_DEFAULT_API_URL}/server-settings`)
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${await response.text()}`)
      }
      const data: ServerInfo = await response.json()
      return data
    },
    staleTime: Infinity, /* If the server settings change, just refresh the page. */
  })
}