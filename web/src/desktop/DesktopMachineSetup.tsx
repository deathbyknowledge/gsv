import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { LoadingState } from "../app/components/ui/Spinner";
import { useGateway } from "../app/services/gateway/GatewayProvider";
import { useSession } from "../app/services/session/SessionProvider";
import { useConsoleAccounts, useConsoleTargets } from "../app/services/system/useConsoleData";
import { canConfigure } from "../app/features/instrument/settings/settingsModel";
import { nativeMachine } from "./bridge";
import { DesktopMachineSession } from "./machineSetup";

type Props = { origin: string; generation: string; request: number; flush(): Promise<void> };

export function DesktopMachineSetup(props: Props) {
  const { snapshot } = useSession();
  if (snapshot.phase !== "ready") return null;
  return <MachineSetup key={JSON.stringify([props.generation, snapshot.username])} {...props} username={snapshot.username} />;
}

function MachineSetup({ origin, generation, username, request, flush }: Props & { username: string }) {
  const { client, connected } = useGateway();
  const key = `gsv.desktop.machine:${JSON.stringify([origin, username])}`;
  const [owner] = useState(() => new DesktopMachineSession(origin, username, nativeMachine(generation, username), client.sys.pair, {
    read: () => window.localStorage.getItem(`${key}.invitation`),
    write: (value) => window.localStorage.setItem(`${key}.invitation`, value),
  }));
  const [state, setState] = useState(owner.snapshot);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return window.localStorage.getItem(`${key}.dismissed`) === "1"; } catch { return false; }
  });
  const [label, setLabel] = useState(owner.pairing.snapshot().draft.label);
  const [storageError, setStorageError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const lastRequest = useRef(request);
  const machine = state.machine;
  const current = machine?.pending ?? machine?.configured;
  const other = current && !owner.matches(current) ? current : null;
  const needsInvitation = !!machine && !machine.configured && !machine.pending;
  const accounts = useConsoleAccounts({ enabled: needsInvitation });
  const targets = useConsoleTargets({ enabled: open });
  const account = accounts.accounts.find((item) => item.username === username);
  const allowed = !needsInvitation || !!account && canConfigure(account, "sys.pair.create");

  useLayoutEffect(() => owner.subscribe(() => setState(owner.snapshot())), [owner]);
  useEffect(() => {
    let active = true;
    void flush().then(() => { if (active) return owner.load(); }).catch(() => {
      if (active) setStorageError("Save your sign-in before connecting this computer. Restart GSV to retry.");
    });
    return () => { active = false; owner.dispose(); };
  }, [owner, flush]);
  useEffect(() => {
    if (machine && !label) setLabel(machine.suggestedName.slice(0, 100));
  }, [machine?.suggestedName]);
  useEffect(() => {
    if (request !== lastRequest.current) { lastRequest.current = request; setOpen(true); }
  }, [request]);
  useEffect(() => {
    if (!dismissed && !state.loading && machine && !other && allowed && (!machine.configured || state.error)) setOpen(true);
  }, [dismissed, state.loading, machine, other, allowed, state.error]);
  useLayoutEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const close = () => {
    setOpen(false); setDismissed(true);
    try { window.localStorage.setItem(`${key}.dismissed`, "1"); } catch { /* The dismissal lasts for this session. */ }
  };
  const online = !!machine?.configured && (machine.connected || targets.targets.some((target) => target.deviceId === machine.configured?.targetId && target.online));
  const error = storageError || state.error;
  return <dialog ref={dialog} class="desktop-machine" aria-labelledby="desktop-machine-title"
    onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => {
      event.preventDefault();
      void owner.connect(label, targets.targets.map((target) => target.deviceId)).then((complete) => { if (complete) close(); });
    }}>
      <h2 id="desktop-machine-title">{machine?.configured?.label ?? "Connect this computer"}</h2>
      {state.loading && !error ? <LoadingState>checking…</LoadingState> : other ?
        <p class="note">Already connected to {new URL(other.origin).host} as {other.username}.</p> : machine?.configured ?
        <p class="note" role="status">{online ? "Connected" : machine.running ? "Connecting…" : "Connection stopped"}</p> : <>
          <p class="note">Let your Ship use this computer’s files and commands, even when the app is closed.</p>
          {!machine?.pending && <label>Name<input value={label} maxLength={100} required autoComplete="off"
            disabled={state.busy} onInput={(event) => setLabel(event.currentTarget.value)} /></label>}
          {needsInvitation && !allowed && !accounts.isPending && <p class="note">Your account cannot connect a computer.</p>}
        </>}
      {error && <p class="error" role="alert">{error}</p>}
      <div class="desktop-machine-actions">
        <button type="button" class="fleet-text-action" onClick={close}>{state.busy ? "close" : machine?.configured || other ? "done" : "not now"}</button>
        {!other && (!machine?.running || state.busy) && <button type={machine ? "submit" : "button"} class="ibtn is-primary"
          disabled={state.busy || state.loading || !!storageError || !connected || !allowed || needsInvitation && (!label.trim() || targets.isPending)}
          onClick={machine ? undefined : () => void owner.load()}>
          {state.busy ? <LoadingState>connecting…</LoadingState> : error || machine?.pending ? "retry" : "connect"}
        </button>}
      </div>
    </form>
  </dialog>;
}
