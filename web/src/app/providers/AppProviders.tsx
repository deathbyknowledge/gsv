import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { GatewayProvider } from "../services/gateway/GatewayProvider";
import { GatewaySignalInvalidator } from "../services/query/GatewaySignalInvalidator";
import { SessionProvider } from "../services/session/SessionProvider";

type AppProvidersProps = {
  children: ComponentChildren;
};

function createWebQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export function AppProviders({ children }: AppProvidersProps) {
  const [queryClient] = useState(createWebQueryClient);

  return (
    <GatewayProvider>
      <SessionProvider>
        <QueryClientProvider client={queryClient}>
          <GatewaySignalInvalidator />
          {children}
        </QueryClientProvider>
      </SessionProvider>
    </GatewayProvider>
  );
}
