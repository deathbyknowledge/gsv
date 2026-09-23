import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { LoadingState, Spinner } from "../app/components/ui/Spinner";
import { AsciiAnimation } from "../app/components/ui/AsciiAnimation";
import { useColorTheme } from "../app/components/ui/useColorTheme";
import { useGateway } from "../app/services/gateway/GatewayProvider";
import { useSession } from "../app/services/session/SessionProvider";
import { useConsoleAccounts, useConsoleTargets } from "../app/services/system/useConsoleData";
import { canConfigure } from "../app/features/instrument/settings/settingsModel";
import { nativeMachine, type NativeSessionStorage } from "./bridge";
import { DesktopMachineSession } from "./machineSetup";
import { createComputerScene } from "./computerScene";

type Props = { origin: string; generation: string; request: number; storage: NativeSessionStorage };

export function DesktopMachineSetup({ storage, ...props }: Props) {
  const { snapshot } = useSession();
  const [savedUser, setSavedUser] = useState<string | null>(null);
  useLayoutEffect(() => storage.subscribeSignedIn(setSavedUser), [storage]);
  if (snapshot.phase !== "ready") return null;
  return <MachineSetup key={JSON.stringify([props.generation, snapshot.username])} {...props} username={snapshot.username}
    nativeReady={savedUser === snapshot.username} />;
}

function MachineSetup({ origin, generation, username, request, nativeReady }: Omit<Props, "storage"> & { username: string; nativeReady: boolean }) {
  const { client, connected } = useGateway();
  const { theme } = useColorTheme();
  const [computer] = useState(createComputerScene);
  const key = `gsv.desktop.machine:${JSON.stringify([origin, username])}`;
  const [owner] = useState(() => new DesktopMachineSession(origin, username, nativeMachine(generation, username), client.sys.pair, {
    read: () => window.localStorage.getItem(`${key}.invitation`),
    write: (value) => window.localStorage.setItem(`${key}.invitation`, value),
  }));
  const [state, setState] = useState(owner.snapshot);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [label, setLabel] = useState(owner.pairing.snapshot().draft.label);
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
  useEffect(() => () => owner.dispose(), [owner]);
  useEffect(() => {
    if (nativeReady) void owner.load();
  }, [owner, nativeReady]);
  useEffect(() => {
    if (machine && !label) setLabel(machine.suggestedName.slice(0, 100));
  }, [machine?.suggestedName]);
  useEffect(() => {
    if (request !== lastRequest.current) {
      lastRequest.current = request;
      setOpen(true);
      if (nativeReady) void owner.load();
    }
  }, [request, nativeReady, owner]);
  useEffect(() => {
    if (!dismissed && !state.loading && !other && (state.error || machine && allowed && !machine.configured)) setOpen(true);
  }, [dismissed, state.loading, machine, other, allowed, state.error]);
  useLayoutEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const close = () => {
    setOpen(false); setDismissed(true);
  };
  const online = !!machine?.configured && (machine.connected || targets.targets.some((target) => target.deviceId === machine.configured?.targetId && target.online));
  const error = state.error;
  const complete = online && !state.busy && !error && !other;
  return <dialog ref={dialog} class="desktop-machine" aria-labelledby="desktop-machine-title"
    onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => {
      event.preventDefault();
      void owner.connect(label, targets.targets.map((target) => target.deviceId));
    }}>
      <h2 id="desktop-machine-title">{machine?.configured?.label ?? "Connect this computer"}</h2>
      {open && !state.loading && !machine?.configured && !other && <AsciiAnimation scene={computer} label="Computer" palette={theme}
        frameRate={12} className="desktop-machine-art" />}
      {state.loading && !error ? <LoadingState>checking…</LoadingState> : other ?
        <p class="note">Already connected to {new URL(other.origin).host} as {other.username}.</p> : machine?.configured ?
        !error && <p class="note" role="status">{state.busy ? "Connecting…" : online ? "Connected" : machine.running ? "Connecting…" : "Connection stopped"}</p> : <>
          <p class="note">Let your Ship use this computer’s files and commands, even when the app is closed.</p>
          {!machine?.pending && <label>Display name<input value={label} maxLength={100} required autoComplete="off"
            disabled={state.busy} onInput={(event) => setLabel(event.currentTarget.value)} /></label>}
          {needsInvitation && !allowed && !accounts.isPending && <p class="note">Your account cannot connect a computer.</p>}
        </>}
      {error && <p class="error" role="alert">{error}</p>}
      <div class="desktop-machine-actions">
        {complete ? <button type="button" class="ibtn is-primary desktop-machine-connect" onClick={close}>done</button> : <>
          <button type="button" class="fleet-text-action" onClick={close}>{state.busy ? "close" : machine?.configured || other ? "done" : "not now"}</button>
          {!other && <button type={machine ? "submit" : "button"} class="ibtn is-primary desktop-machine-connect"
            disabled={state.busy || state.loading || !nativeReady || !connected || !allowed || needsInvitation && (!label.trim() || targets.isPending)}
            aria-label={state.busy ? "Connecting" : undefined} aria-busy={state.busy}
            onClick={machine ? undefined : () => void owner.load()}>
            {state.busy ? <Spinner /> : error || machine?.pending ? "retry" : "connect"}
          </button>}
        </>}
      </div>
    </form>
  </dialog>;
}
