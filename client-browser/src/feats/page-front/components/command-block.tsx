import { toast } from "sonner"

export function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="space-y-2">
      <button
        onClick={() => { navigator.clipboard.writeText(command); toast.success("Copied!") }}
        className="text-xs font-medium text-gray-500 underline underline-offset-2"
      >
        {label} (Click to copy)
      </button>
      <pre className="overflow-x-auto whitespace-pre rounded border bg-gray-50 p-2 font-mono text-xs">{command}</pre>
    </div>
  )
}
