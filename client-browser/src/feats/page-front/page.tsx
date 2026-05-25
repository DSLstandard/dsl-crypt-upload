import { DownloadSection } from "./components/download-section"
import { UploadSection } from "./components/upload-section"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

export function FrontPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Header — full width */}
      <header className="bg-sky-700 px-4 py-4 text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div>
            <h1 className="font-black">DSL Crypt Upload</h1>
            <p className="mt-1 text-sky-100 text-xs">
              Zero-knowledge file sharing, with shell commands for devs and LLMs
            </p>
          </div>
          <a className="shrink-0 cursor-pointer text-sm text-sky-200 underline underline-offset-2 hover:text-white" href="https://github.com/DSLstandard/dsl-crypt-upload">
            GitHub
          </a>
        </div>
      </header>

      {/* Side-by-side sections on large screens */}
      <div className="mx-auto w-full container flex-1 py-2 lg:grid lg:grid-cols-2 max-lg:flex max-lg:flex-col gap-2">
        <DownloadSection />
        <UploadSection />
      </div>
    </div>
  )
}

