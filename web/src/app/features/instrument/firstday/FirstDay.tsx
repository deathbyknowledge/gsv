import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useQuery } from "@tanstack/preact-query";
import { AsciiGalaxyScan } from "../../../components/ui/AsciiGalaxyScan";
import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
import { browserExtensionDownloadUrl } from "../../../domain/cliInstall";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { listChatProcesses, sendChatMessage } from "../../chat/backend/chatService";
import type { IssuedMachineNodeToken } from "../../gsv-console/backend/consoleService";
import type { ConnectFlowShellProps } from "../../gsv-console/connect-flows/ConnectFlowShell";
import { loadContactsWorkspace, mutateContactsWorkspace } from "../../gsv-console/contacts/contactsService";
import {
  useConfirmConsoleAdapterPairing,
  useConsoleAdapterPairingInfo,
  useConsoleIdentityLinks,
  useConsoleTargets,
  useCreateMachineNodeToken,
  useInspectConsoleAdapterPairing,
} from "../../gsv-console/hooks/useConsoleData";
import {
  buildMachineBootstrapCommand,
  buildMachineInstallCommand,
  defaultMachineName,
  expiresAtFromDays,
  machineDeviceIdFromName,
} from "../../gsv-console/machines/machineProvision";
import {
  ManagedTelegramOnboardingFlow,
  type ManagedTelegramDependencies,
} from "../../gsv-console/messengers/ManagedTelegramOnboardingFlow";
import { PromptLine } from "../shared/PromptLine";
import { Wordmark } from "../shared/Wordmark";
import {
  connectedCount,
  derivePlaces,
  joinNames,
  nextToConnect,
  promptIntent,
  reachablePlaces,
  uniqueDeviceId,
  type ComputerOs,
  type PlaceId,
  type PlaceRow,
} from "./firstdayModel";
import "./firstday.css";

export type FirstDayProps = {
  /** Back to Zen. There is nothing to finish: the read state is this manifest with rows lit. */
  onZen: () => void;
};

const OS_CHOICES: readonly { id: ComputerOs; label: string }[] = [
  { id: "mac", label: "Mac" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

const contactsQueryKey = ["instrument", "firstday", "contacts"] as const;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function errorText(error: Error | null): string {
  return error ? error.message : "";
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
  const [os, setOs] = useState<ComputerOs | null>(null);
  const [issued, setIssued] = useState<{ os: ComputerOs; deviceId: string; token: IssuedMachineNodeToken } | null>(null);

  const choose = (next: ComputerOs) => {
    setOs(next);
    if (issued?.os === next || createToken.isPending) return;
    const deviceId = uniqueDeviceId(machineDeviceIdFromName(defaultMachineName(next)), taken);
    void createToken
      .mutateAsync({ deviceId, label: defaultMachineName(next), expiresAt: expiresAtFromDays(30) })
      .then((token) => setIssued({ os: next, deviceId, token }));
  };

  const installCommand = os ? buildMachineInstallCommand(os, release) : "";
  const connectCommand = issued && issued.os === os
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
            onClick={() => choose(choice.id)}
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
            ) : createToken.isError ? (
              <pre class="is-error">{errorText(createToken.error)}</pre>
            ) : (
              <pre class="is-dim">minting a key for this computer…</pre>
            )}
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

export function FirstDay({ onZen }: FirstDayProps) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const targets = useConsoleTargets();
  const identityLinks = useConsoleIdentityLinks();
  const contacts = useQuery({
    queryKey: contactsQueryKey,
    enabled: connected,
    queryFn: () => loadContactsWorkspace(client),
    refetchInterval: 10_000,
  });
  const [telegramPaired, setTelegramPaired] = useState(false);
  const [open, setOpen] = useState<PlaceId | null>(null);
  const [status, setStatus] = useState("");

  const rows = useMemo<PlaceRow[]>(() => {
    const derived = derivePlaces({
      targets: targets.targets.map((target) => ({ kind: target.kind, online: target.online, label: target.label })),
      identityLinks: identityLinks.links.map((link) => ({ adapter: link.adapter })),
      contacts: (contacts.data?.contacts ?? []).map((contact) => ({ state: contact.state, alias: contact.localAlias ?? null })),
    });
    return telegramPaired
      ? derived.map((row) => (row.id === "telegram" && row.lit === null ? { ...row, lit: "Telegram" } : row))
      : derived;
  }, [contacts.data, identityLinks.links, targets.targets, telegramPaired]);

  useEffect(() => {
    if (open === null) setOpen(nextToConnect(rows));
  }, [open, rows]);

  const release = snapshot.server?.release ?? "dev";
  const username = snapshot.username || "root";
  const origin = window.location.origin;
  const taken = targets.targets.map((target) => target.deviceId);
  const count = connectedCount(rows);

  const submit = (text: string) => {
    const intent = promptIntent(text);
    if (intent) {
      setOpen(intent);
      setStatus(`opened ${rows.find((row) => row.id === intent)?.name.toLowerCase() ?? intent}`);
      return;
    }
    setStatus("sending to your ship…");
    void listChatProcesses(client)
      .then((processes) => {
        const ship = processes.find((process) => process.personal) ?? processes[0];
        if (!ship) throw new Error("no process to talk to yet");
        return sendChatMessage(client, { pid: ship.pid, message: text });
      })
      .then(() => setStatus("sent · press n to see the answer in zen"))
      .catch((cause: Error) => setStatus(`could not send: ${cause.message}`));
  };

  return (
    <main class="firstday" aria-label="First day">
      <div class="instrument-top">
        <Wordmark />
        <span>your ship · first day</span>
        <span class="keys">
          <button type="button" onClick={onZen}><kbd>n</kbd>back to the read state</button>
        </span>
      </div>
      <div class="fd-body">
        <div class="fd-inner">
          <div class="fd-galaxy">
            <AsciiGalaxyScan
              showNebula={false}
              showStars={false}
              showTexture
              cols={150}
              rows={48}
              particleCount={2600}
              label="GSV forming"
            />
          </div>
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
                      <div class="fd-orb"><AsciiPlanet variant="orb" animate={false} showStars={false} label={`${row.lit} body`} /></div>
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
      <div class="fd-foot">
        <div class="instrument-status">
          <span class="is-on">cloud home connected</span>
          <span>{count} of {rows.length} places connected</span>
          <span>{status || "you can ask me to do any of this from the prompt instead"}</span>
        </div>
        <PromptLine
          who={username}
          where="gsv"
          dir="~"
          placeholder="connect my laptop"
          onSubmit={submit}
          autoFocus
        />
      </div>
    </main>
  );
}

export { joinNames };
