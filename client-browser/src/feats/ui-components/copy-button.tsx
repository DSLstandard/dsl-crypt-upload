import { Button } from "@/components/ui/button";
import clsx from "clsx";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export interface CopyButtonProps {
  className?: string

  /**
   * Content string to be copied to clipboard.
   */
  copyContent?: string;

  /**
   * Alternative to `copyContent`. If `copyContent` is not provided, this
   * function will be called when the copy button is clicked.
   */
  onCopy?: () => Promise<void> | void;
}

const JUST_COPIED_STALE_TIME = 2000

export function CopyButton(props: CopyButtonProps) {
  const [justCopied, setJustCopied] = useState(false)

  const onCopyButtonClicked = async () => {
    if (props.copyContent !== undefined) {
      await navigator.clipboard.writeText(props.copyContent)
    } else if (props.onCopy !== undefined) {
      await props.onCopy()
    } else {
      // No-op. DON'T CRASH. The developer is probably just testing.
    }

    toast.success("Copied to clipboard!")

    setJustCopied(true)
    setTimeout(() => setJustCopied(false), JUST_COPIED_STALE_TIME)
  }

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={onCopyButtonClicked}
      className={clsx("shrink-0", props.className)}
      aria-label="Copy to clipboard"
    >
      {justCopied ? (
        <CheckIcon className="text-green-600" />
      ) : (
        <CopyIcon className="size-4" />
      )}
    </Button>
  )
}
