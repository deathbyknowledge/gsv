import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { AdvancedPanel } from "./advanced-panel";
import { AccessPanel } from "./access-panel";
import { ConfigPanel } from "./config-panel";
import { Tabs } from "./tabs";
import type {
  ControlBackend,
  ControlConfigSectionId,
  ControlCreatedToken,
  ControlState,
  ControlTabId,
  CreateLinkArgs,
  CreateTokenArgs,
} from "./types";

type AppProps = {
  backend: ControlBackend;
};

export function App({ backend }: AppProps) {
  const [state, setState] = useState<ControlState | null>(null);
  const [activeTab, setActiveTab] = useState<ControlTabId>(readTabFromLocation());
  const [activeConfigSection, setActiveConfigSection] = useState<ControlConfigSectionId>(readSectionFromLocation());
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<ControlCreatedToken | null>(null);

  const updateRoute = useCallback((nextTab: ControlTabId, nextSection: ControlConfigSectionId = activeConfigSection) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", nextTab);
    url.searchParams.set("section", nextSection);
    window.history.pushState({}, "", url);
    setActiveTab(nextTab);
    setActiveConfigSection(nextSection);
  }, [activeConfigSection]);

  const updateConfigSection = useCallback((nextSection: ControlConfigSectionId) => {
    updateRoute("config", nextSection);
  }, [updateRoute]);

  useEffect(() => {
    const onPopState = () => {
      setActiveTab(readTabFromLocation());
      setActiveConfigSection(readSectionFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const refresh = useCallback(async () => {
    setPendingAction("load-state");
    try {
      const nextState = await backend.loadState({});
      setState(nextState);
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runStateAction = useCallback(
    async (actionId: string, action: () => Promise<ControlState>) => {
      setPendingAction(actionId);
      try {
        const nextState = await action();
        setState(nextState);
        setError(null);
      } catch (cause) {
        setError(formatError(cause));
      } finally {
        setPendingAction(null);
      }
    },
    [],
  );

  const content = useMemo(() => {
    if (!state) {
      return <section class="control-pane"><p>Loading control state…</p></section>;
    }

    if (activeTab === "config") {
      return (
        <ConfigPanel
          entries={state.configEntries}
          values={state.configValues}
          pendingKey={pendingAction?.startsWith("save:") ? pendingAction.slice(5) : null}
          activeSection={activeConfigSection}
          onSelectSection={updateConfigSection}
          onSaveEntry={async (key, value) => {
            setIssuedToken(null);
            await runStateAction(`save:${key}`, () => backend.saveEntry({ key, value }));
          }}
        />
      );
    }

    if (activeTab === "access") {
      return (
        <AccessPanel
          tokens={state.tokens}
          links={state.links}
          issuedToken={issuedToken}
          pendingAction={pendingAction}
          onCreateToken={async (args: CreateTokenArgs) => {
            setPendingAction("create-token");
            try {
              const result = await backend.createToken(args);
              setState(result.state);
              setIssuedToken(result.token);
              setError(null);
            } catch (cause) {
              setError(formatError(cause));
            } finally {
              setPendingAction(null);
            }
          }}
          onRevokeToken={async (tokenId) => {
            setIssuedToken(null);
            await runStateAction(`revoke:${tokenId}`, () => backend.revokeToken({ tokenId }));
          }}
          onConsumeLinkCode={async (code) => {
            setIssuedToken(null);
            await runStateAction("consume-link", () => backend.consumeLinkCode({ code }));
          }}
          onCreateLink={async (args: CreateLinkArgs) => {
            setIssuedToken(null);
            await runStateAction("create-link", () => backend.createLink(args));
          }}
          onUnlink={async (link) => {
            setIssuedToken(null);
            await runStateAction(
              `unlink:${link.adapter}:${link.accountId}:${link.actorId}`,
              () => backend.unlink({
                adapter: link.adapter,
                accountId: link.accountId,
                actorId: link.actorId,
              }),
            );
          }}
        />
      );
    }

    return (
      <AdvancedPanel
        entries={state.configEntries}
        pendingAction={pendingAction}
        onApply={async (entries) => {
          setIssuedToken(null);
          await runStateAction("raw-save", () => backend.applyRawConfig({ entries }));
        }}
        onClientError={setError}
      />
    );
  }, [activeConfigSection, activeTab, backend, issuedToken, pendingAction, runStateAction, state, updateConfigSection]);

  return (
    <div class="control-app">
      <header class="control-toolbar">
        <div>
          <h1>Control</h1>
          <p>System settings, runtime profiles, access tokens, and identity links.</p>
        </div>
        <div class="control-toolbar-actions">
          <button class="control-button" disabled={pendingAction === "load-state"} onClick={() => void refresh()}>
            {pendingAction === "load-state" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      <Tabs activeTab={activeTab} onChange={(tab) => updateRoute(tab)} />
      {error ? <p class="control-error-text">{error}</p> : null}
      <main class="control-main">{content}</main>
    </div>
  );
}

function readTabFromLocation(): ControlTabId {
  const value = new URL(window.location.href).searchParams.get("tab");
  return value === "access" || value === "advanced" ? value : "config";
}

function readSectionFromLocation(): ControlConfigSectionId {
  const value = new URL(window.location.href).searchParams.get("section");
  return value === "profiles" || value === "shell" || value === "server" || value === "processes" || value === "automation"
    ? value
    : "ai";
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
