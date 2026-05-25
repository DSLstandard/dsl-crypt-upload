
export function getContentLength(response: Response): number | null {
  const raw = response.headers.get("Content-Length")

  if (!raw) {
    return null
  }

  const parsed = parseInt(raw)
  if (isNaN(parsed)) {
    return null
  }

  return parsed
}