// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import QRCode from "react-qr-code"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

interface QrCodeDialogProps {
  url: string
  children: React.ReactNode
}

export function QrCodeDialog({ url, children }: QrCodeDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>
            Scan QR Code
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-row justify-center items-center">
          <div className="p-4 border rounded">
            <QRCode value={url} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
