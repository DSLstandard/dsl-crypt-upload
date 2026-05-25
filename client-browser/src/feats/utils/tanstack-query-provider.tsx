import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useMemo } from "react"


export function TanstackQueryProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useMemo(() => {
    return new QueryClient()
  }, [])
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}
