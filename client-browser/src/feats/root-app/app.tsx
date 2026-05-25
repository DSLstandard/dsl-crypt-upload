import { TanstackQueryProvider } from "../utils/tanstack-query-provider";
import { FrontPage } from "../page-front/page";
import { Toaster } from "sonner";

export function RootApp() {
  return (
    <>
      <Toaster />
      <TanstackQueryProvider>
        <FrontPage />
      </TanstackQueryProvider>
    </>
  )
}