import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useQuery } from "@tanstack/preact-query";
import { browserExtensionDownloadUrl } from "../../../domain/cliInstall";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { loadConsoleTargets } from "../../../services/system/consoleService";
import type { ConnectFlowShellProps } from "../../../components/connect-flow/ConnectFlowShell";
import { mutateContactsWorkspace } from "../../../services/contacts/contactsService";
import {
  useConfirmConsoleAdapterPairing,
  useConsoleAdapterPairingInfo,
  useConsoleIdentityLinks,
  useCreateMachineNodeToken,
  useInspectConsoleAdapterPairing,
} from "../../../services/system/useConsoleData";
import {
  buildMachineBootstrapCommand,
  buildMachineInstallCommand,
} from "../../../services/machines/machineProvision";
import {
  ManagedTelegramOnboardingFlow,
  type ManagedTelegramDependencies,
} from "../settings/messengers/ManagedTelegramOnboardingFlow";
import { INSTRUMENT_CONTACTS_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import {
  derivePlaces,
  joinNames,
  nextToConnect,
  reachablePlaces,
  type ComputerOs,
  type PlaceId,
  type PlaceRow,
} from "./firstdayModel";
import { useComputerPairing } from "./useComputerPairing";
import "./firstday.css";

const OS_CHOICES: readonly { id: ComputerOs; label: string }[] = [
  { id: "mac", label: "Mac" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Renders one step of a console connect flow inside our panel, without the console's page chrome. */
function CompactFlowShell({ flow, current, onStep }: ConnectFlowShellProps): ComponentChildren {
  const lastIndex = flow.steps.length - 1;
  const index = Math.max(0, Math.min(current, lastIndex));
  const step = flow.steps[index];
  return (
    <div class="fd-flow">
      <div class="fd-flow-step">{step.meta} · {step.title}</div>
      {step.render({
        onBack: () => onStep(Math.max(0, index - 1)),
        onNext: () => onStep(Math.min(lastIndex, index + 1)),
        goTo: onStep,
        isFirst: index === 0,
        isLast: index === lastIndex,
      })}
    </div>
  );
}

const compactTelegramDependencies: ManagedTelegramDependencies = {
  ConnectFlowShell: (props) => <CompactFlowShell {...props} />,
  // The first day has no page navigation to guard; leaving a row mid-pairing is fine.
  useUnsavedGuard: () => {},
  useConsoleAdapterPairingInfo: (adapter) => useConsoleAdapterPairingInfo(adapter),
  useInspectConsoleAdapterPairing: () => useInspectConsoleAdapterPairing(),
  useConfirmConsoleAdapterPairing: () => useConfirmConsoleAdapterPairing(),
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="ibtn"
      onClick={() => {
        void copyText(text).then((ok) => {
          setCopied(ok);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? "copied" : label}
    </button>
  );
}

function ComputerPanel({ release, taken, username, origin }: {
  release: string;
  taken: readonly string[];
  username: string;
  origin: string;
}) {
  const createToken = useCreateMachineNodeToken();
  const { client, connected } = useGateway();
  const { os, issued, pending, error, choose } = useComputerPairing({ create: createToken.mutateAsync, revoke: client.sys.token.revoke }, taken);

  const installCommand = os ? buildMachineInstallCommand(os, release) : "";
  const connectCommand = !pending && issued && issued.os === os
    ? buildMachineBootstrapCommand({ origin, platform: issued.os, username, deviceId: issued.deviceId, token: issued.token.token })
    : "";

  return (
    <>
      <p>Pick the computer you're on. Two lines in a terminal: one installs GSV, one tells it who you are. This row lights up on its own when the computer says hello, and it keeps itself up to date from then on.</p>
      <div class="choices">
        {OS_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            class={`ibtn${os === choice.id ? " is-primary" : ""}`}
            disabled={!connected || pending}
            onClick={() => void choose(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {os ? (
        <div class="fd-commands">
          <div class="fd-command">
            <div class="fd-command-head"><span>1 · install</span><CopyButton text={installCommand} label="copy" /></div>
            <pre>{installCommand}</pre>
          </div>
          <div class="fd-command">
            <div class="fd-command-head">
              <span>2 · connect as {username}</span>
              {connectCommand ? <CopyButton text={connectCommand} label="copy" /> : null}
            </div>
            {connectCommand ? (
              <pre>{connectCommand}</pre>
            ) : error ? null : (
              <pre class="is-dim">preparing a key for this computer…</pre>
            )}
            {error ? <pre class="is-error" role="alert">{error}</pre> : null}
          </div>
          {issued ? <p class="fd-note">The key is only shown here, once, and expires in 30 days if the computer never connects.</p> : null}
        </div>
      ) : null}
    </>
  );
}

function BrowserPanel({ release }: { release: string }) {
  return (
    <>
      <p>Add the GSV extension to Chrome. It appears here as a place I can reach, and you choose per site whether I'm allowed in.</p>
      <div class="choices">
        <a class="ibtn is-primary" href={browserExtensionDownloadUrl(release)} target="_blank" rel="noreferrer">Download the extension</a>
      </div>
      <p class="fd-note">Unzip it, open chrome://extensions, turn on developer mode, and load the folder. It pairs from its options page with the same key flow as a computer.</p>
    </>
  );
}

function PersonPanel() {
  const { client } = useGateway();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const invite = () => {
    if (pending) return;
    setPending(true);
    setError("");
    void mutateContactsWorkspace(client, { kind: "invite.create" })
      .then((result) => {
        if (result.kind === "invite.created") setCode(result.invite.code);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setPending(false));
  };

  return (
    <>
      <p>Send this code to someone with their own GSV. When they accept, they appear here and files can be shared by reference, without copies.</p>
      {code ? (
        <>
          <div class="code">{code}</div>
          <div class="choices"><CopyButton text={code} label="copy the code" /></div>
        </>
      ) : (
        <div class="choices">
          <button type="button" class="ibtn is-primary" disabled={pending} onClick={invite}>
            {pending ? "creating…" : "Create an invite"}
          </button>
        </div>
      )}
      {error ? <p class="fd-note is-error">{error}</p> : null}
    </>
  );
}

function TelegramPanel({ onConnected, onCollapse }: { onConnected: () => void; onCollapse: () => void }) {
  return (
    <ManagedTelegramOnboardingFlow
      onBack={onCollapse}
      onConnected={onConnected}
      dependencies={compactTelegramDependencies}
    />
  );
}

export function FirstDay() {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const targets = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected });
  const identityLinks = useConsoleIdentityLinks();
  const contacts = useQuery({
    queryKey: INSTRUMENT_CONTACTS_KEY,
    enabled: connected,
    queryFn: async () => (await client.contact.list({ includeRevoked: true })).contacts,
  });
  const [telegramPaired, setTelegramPaired] = useState(false);
  const [open, setOpen] = useState<PlaceId | null | undefined>(undefined);

  const rows = useMemo<PlaceRow[]>(() => {
    const derived = derivePlaces({
      targets: (targets.data ?? []).map((target) => ({ kind: target.kind, online: target.online, label: target.label })),
      identityLinks: identityLinks.links.map((link) => ({ adapter: link.adapter })),
      contacts: (contacts.data ?? []).map((contact) => ({ state: contact.state, alias: contact.localAlias ?? null })),
    });
    return telegramPaired
      ? derived.map((row) => (row.id === "telegram" && row.lit === null ? { ...row, lit: "Telegram" } : row))
      : derived;
  }, [contacts.data, identityLinks.links, targets.data, telegramPaired]);

  useEffect(() => {
    if (open === undefined && !targets.isPending && !identityLinks.isPending && !contacts.isPending) setOpen(nextToConnect(rows));
  }, [open, rows, targets.isPending, identityLinks.isPending, contacts.isPending]);

  const release = snapshot.server?.release ?? "dev";
  const username = snapshot.username || "root";
  const gateway = new URL(snapshot.url);
  gateway.protocol = gateway.protocol === "wss:" ? "https:" : gateway.protocol === "ws:" ? "http:" : gateway.protocol;
  const origin = gateway.origin;
  const taken = (targets.data ?? []).map((target) => target.deviceId);
  return (
    <section class="zen-empty zen-first-day" aria-label="First day">
      <div class="fd-body">
        <div class="fd-inner">
          <p class="fd-hello">
            I'm your ship. Right now I can reach{" "}
            {reachablePlaces(rows).map((name, index, all) => (
              <span key={name}>
                <span class="place">{name}</span>
                {index < all.length - 2 ? ", " : index === all.length - 2 ? (all.length === 2 ? " and " : ", and ") : ""}
              </span>
            ))}
            . Connect a place below and I can reach it too. Each one takes about a minute.
          </p>
          <div>
            {rows.map((row) => {
              const isOpen = open === row.id && row.lit === null;
              return (
                <div key={row.id} class={`fd-row${row.lit ? " is-lit" : ""}${isOpen ? " is-open" : ""}`}>
                  <span class="ring" />
                  <div class="name">
                    {row.lit ?? row.name}
                    <small>{row.lit ? "connected" : row.sub}</small>
                  </div>
                  <div>
                    {row.lit ? (
                      <span class="state">ready</span>
                    ) : (
                      <button type="button" class="ibtn" onClick={() => setOpen(isOpen ? null : row.id)}>
                        {isOpen ? "later" : "connect"}
                      </button>
                    )}
                  </div>
                  <div class="fd-panel">
                    {isOpen && row.id === "computer" ? (
                      <ComputerPanel release={release} taken={taken} username={username} origin={origin} />
                    ) : isOpen && row.id === "telegram" ? (
                      <TelegramPanel onConnected={() => setTelegramPaired(true)} onCollapse={() => setOpen(null)} />
                    ) : isOpen && row.id === "browser" ? (
                      <BrowserPanel release={release} />
                    ) : isOpen && row.id === "person" ? (
                      <PersonPanel />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

export { joinNames };
