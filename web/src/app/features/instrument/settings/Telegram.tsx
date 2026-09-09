import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ConnectFlowShellProps } from "../../gsv-console/connect-flows/ConnectFlowShell";
import { useConsoleAdapterPairingInfo, useInspectConsoleAdapterPairing, useConfirmConsoleAdapterPairing } from "../../gsv-console/hooks/useConsoleData";
import { ManagedTelegramOnboardingFlow, type ManagedTelegramDependencies } from "../../gsv-console/messengers/ManagedTelegramOnboardingFlow";

/** Renders one step of a console connect flow inside our panel, without the console's page chrome. */
function CompactFlowShell({ flow, current, onStep }: ConnectFlowShellProps): ComponentChildren {
  const lastIndex = flow.steps.length - 1;
  const index = Math.max(0, Math.min(current, lastIndex));
  const step = flow.steps[index];
  return (
    <div class="settings-telegram-flow">
      <div class="settings-telegram-step">{step.meta} · {step.title}</div>
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
  // Settings now keeps this flow mounted when switching sections.
  useUnsavedGuard: () => {},
  useConsoleAdapterPairingInfo: (adapter) => useConsoleAdapterPairingInfo(adapter),
  useInspectConsoleAdapterPairing: () => useInspectConsoleAdapterPairing(),
  useConfirmConsoleAdapterPairing: () => useConfirmConsoleAdapterPairing(),
};

export function Telegram() {
  const [open, setOpen] = useState(false);
  const [paired, setPaired] = useState(false);
  return <section class="settings-telegram" aria-label="Telegram">
    <h2>Telegram</h2>
    <p class="settings-muted">Talk to your Ship from Telegram.</p>
    {paired && <p role="status">Telegram is connected.</p>}
    <div class="settings-actions"><button class="ibtn" type="button" onClick={() => setOpen((value) => !value)}>{open ? "close setup" : "connect Telegram"}</button></div>
    {open && <ManagedTelegramOnboardingFlow dependencies={compactTelegramDependencies} onBack={() => setOpen(false)} onConnected={() => { setPaired(true); setOpen(false); }} />}
  </section>;
}
