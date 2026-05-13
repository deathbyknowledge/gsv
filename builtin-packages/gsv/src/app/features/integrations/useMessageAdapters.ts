import { useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import { EMPTY_ADAPTERS_STATE, getAdapterMeta } from "./integrations-domain";
import type {
  AdapterAccount,
  AdapterConnectChallenge,
  AdapterKind,
  AdaptersState,
} from "./types";

export type AdapterChallengeState = {
  adapter: AdapterKind;
  accountId: string;
  value: AdapterConnectChallenge;
};

export type MessageAdaptersRuntime = {
  state: AdaptersState;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  selectedAdapter: AdapterKind;
  selectedAccount: string;
  adapterMeta: ReturnType<typeof getAdapterMeta>;
  accounts: AdapterAccount[];
  currentAccount: AdapterAccount | null;
  visibleChallenge: AdapterConnectChallenge | null;
  whatsappName: string;
  whatsappForce: boolean;
  discordName: string;
  discordToken: string;
  selectAdapter(adapter: AdapterKind): void;
  selectAccount(accountId: string): void;
  setWhatsappName(value: string): void;
  setWhatsappForce(value: boolean): void;
  setDiscordName(value: string): void;
  setDiscordToken(value: string): void;
  refresh(): Promise<void>;
  submitConnect(event: Event): Promise<void>;
  disconnectCurrentAccount(): Promise<void>;
};

export function useMessageAdapters(backend: GsvBackend): MessageAdaptersRuntime {
  const [state, setState] = useState<AdaptersState>(EMPTY_ADAPTERS_STATE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedAdapter, setSelectedAdapter] = useState<AdapterKind>(readAdapterFromLocation());
  const [selectedAccount, setSelectedAccount] = useState<string>(readAccountFromLocation());
  const [challenge, setChallenge] = useState<AdapterChallengeState | null>(null);
  const [whatsappName, setWhatsappName] = useState("primary");
  const [whatsappForce, setWhatsappForce] = useState(false);
  const [discordName, setDiscordName] = useState("main");
  const [discordToken, setDiscordToken] = useState("");

  const adapterMeta = useMemo(() => getAdapterMeta(selectedAdapter), [selectedAdapter]);
  const accounts = state.statusByAdapter[selectedAdapter] ?? [];
  const currentAccount = selectedAccount === "new"
    ? null
    : accounts.find((account) => account.accountId === selectedAccount) ?? null;
  const visibleChallenge = challenge
    && challenge.adapter === selectedAdapter
    && challenge.accountId === (currentAccount?.accountId ?? selectedAccount)
    ? challenge.value
    : null;

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const preferred = selectedAccount.trim();
    if (preferred === "new") {
      return;
    }
    if (preferred && accounts.some((account) => account.accountId === preferred)) {
      return;
    }
    const nextAccount = accounts[0]?.accountId ?? "new";
    setSelectedAccount(nextAccount);
    writeIntegrationRoute({ adapter: selectedAdapter, account: nextAccount });
  }, [selectedAdapter, accounts]);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setState(await backend.loadAdaptersState());
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function runMutation(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setBusy(false);
    }
  }

  function selectAdapter(adapter: AdapterKind): void {
    const nextAccounts = state.statusByAdapter[adapter] ?? [];
    const nextAccount = nextAccounts[0]?.accountId ?? "new";
    setSelectedAdapter(adapter);
    setSelectedAccount(nextAccount);
    setChallenge(null);
    writeIntegrationRoute({ adapter, account: nextAccount });
  }

  function selectAccount(accountId: string): void {
    setSelectedAccount(accountId);
    setChallenge(null);
    writeIntegrationRoute({ adapter: selectedAdapter, account: accountId });
  }

  async function submitConnect(event: Event): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      const accountId = selectedAdapter === "whatsapp" ? whatsappName.trim() : discordName.trim();
      const config = selectedAdapter === "whatsapp"
        ? { force: whatsappForce }
        : discordToken.trim()
          ? { botToken: discordToken.trim() }
          : undefined;
      const result = await backend.connectAdapter({
        adapter: selectedAdapter,
        accountId,
        config,
      });
      setNotice(result.statusText);
      if (result.challenge) {
        setChallenge({ adapter: selectedAdapter, accountId, value: result.challenge });
      } else {
        setChallenge(null);
      }
      if (!result.ok) {
        setError(result.error || result.statusText);
        return;
      }
      if (selectedAdapter === "discord") {
        setDiscordToken("");
      }
      await refresh();
      setSelectedAccount(accountId);
      writeIntegrationRoute({ adapter: selectedAdapter, account: accountId });
    });
  }

  async function disconnectCurrentAccount(): Promise<void> {
    if (!currentAccount) return;
    await runMutation(async () => {
      const result = await backend.disconnectAdapter({
        adapter: selectedAdapter,
        accountId: currentAccount.accountId,
      });
      setNotice(result.statusText);
      if (!result.ok) {
        setError(result.error || result.statusText);
        return;
      }
      setChallenge(null);
      await refresh();
      setSelectedAccount("new");
      writeIntegrationRoute({ adapter: selectedAdapter, account: "new" });
    });
  }

  return {
    state,
    loading,
    busy,
    error,
    notice,
    selectedAdapter,
    selectedAccount,
    adapterMeta,
    accounts,
    currentAccount,
    visibleChallenge,
    whatsappName,
    whatsappForce,
    discordName,
    discordToken,
    selectAdapter,
    selectAccount,
    setWhatsappName,
    setWhatsappForce,
    setDiscordName,
    setDiscordToken,
    refresh,
    submitConnect,
    disconnectCurrentAccount,
  };
}

function readAdapterFromLocation(): AdapterKind {
  const value = new URL(window.location.href).searchParams.get("adapter");
  return value === "discord" ? "discord" : "whatsapp";
}

function readAccountFromLocation(): string {
  const value = new URL(window.location.href).searchParams.get("account");
  return value?.trim() || "new";
}

function writeIntegrationRoute(args: { adapter: AdapterKind; account: string }): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "integrations");
  url.searchParams.set("type", "message-adapters");
  url.searchParams.set("adapter", args.adapter);
  url.searchParams.set("account", args.account || "new");
  window.history.replaceState({}, "", url);
}
