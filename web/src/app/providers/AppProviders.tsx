import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, ComponentType } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { GatewayProvider } from "../services/gateway/GatewayProvider";
import { GatewaySignalInvalidator } from "../services/query/GatewaySignalInvalidator";
import { SessionProvider, useSession } from "../services/session/SessionProvider";
import type {
  SessionClient,
  SessionService,
  SessionSnapshot,
} from "../services/session/sessionService";

type AppProvidersProps = {
  children: ComponentChildren;
};

type QueryInvalidatorComponent = ComponentType;
type SessionServiceFactory = (client: SessionClient) => SessionService;

export type AppProviderDependencies = {
  QueryInvalidator?: QueryInvalidatorComponent;
  createSessionService?: SessionServiceFactory;
};

export function createWebQueryClient(): QueryClient {
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

export type ScopedWebQueryClient = {
  client: QueryClient;
  scope: string;
};

export function webQuerySessionScope(snapshot: SessionSnapshot): string {
  const username = snapshot.username.trim();
  return snapshot.phase === "ready" && username ? `user:${username}` : "signed-out";
}

export function resolveScopedWebQueryClient(
  current: ScopedWebQueryClient | null,
  scope: string,
): ScopedWebQueryClient {
  return current?.scope === scope
    ? current
    : { client: createWebQueryClient(), scope };
}

type SessionScopedQueryProviderProps = AppProvidersProps & {
  QueryInvalidator?: QueryInvalidatorComponent;
  scope: string;
};

function ScopedQueryTree({
  children,
  client,
  QueryInvalidator,
}: AppProvidersProps & {
  client: QueryClient;
  QueryInvalidator: QueryInvalidatorComponent;
}) {
  return (
    <QueryClientProvider client={client}>
      <QueryInvalidator />
      {children}
    </QueryClientProvider>
  );
}

export function SessionScopedQueryProvider({
  children,
  QueryInvalidator = GatewaySignalInvalidator,
  scope,
}: SessionScopedQueryProviderProps) {
  const stateRef = useRef<ScopedWebQueryClient | null>(null);
  const state = resolveScopedWebQueryClient(
    stateRef.current,
    scope,
  );
  stateRef.current = state;

  useEffect(() => {
    return () => state.client.clear();
  }, [state.client]);

  return (
    <ScopedQueryTree
      key={state.scope}
      client={state.client}
      QueryInvalidator={QueryInvalidator}
    >
      {children}
    </ScopedQueryTree>
  );
}

function SessionQueryProvider({
  children,
  QueryInvalidator,
}: AppProvidersProps & Pick<AppProviderDependencies, "QueryInvalidator">) {
  const { snapshot } = useSession();
  return (
    <SessionScopedQueryProvider
      scope={webQuerySessionScope(snapshot)}
      QueryInvalidator={QueryInvalidator}
    >
      {children}
    </SessionScopedQueryProvider>
  );
}

export function AppProviders({
  children,
  QueryInvalidator,
  createSessionService,
}: AppProvidersProps & AppProviderDependencies) {
  return (
    <GatewayProvider>
      <SessionProvider createService={createSessionService}>
        <SessionQueryProvider QueryInvalidator={QueryInvalidator}>
          {children}
        </SessionQueryProvider>
      </SessionProvider>
    </GatewayProvider>
  );
}
