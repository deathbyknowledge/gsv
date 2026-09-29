import type { ComponentChildren } from "preact";
import type { ConnectFlowShellProps } from "../../../components/connect-flow/ConnectFlowShell";
import { useConsoleAdapterPairingInfo, useInspectConsoleAdapterPairing, useConfirmConsoleAdapterPairing } from "../../../services/system/useConsoleData";
import { SharedDiscordOnboardingFlow, ManagedSlackOnboardingFlow, ManagedTelegramOnboardingFlow, type ManagedTelegramDependencies } from "./messengers/ManagedTelegramOnboardingFlow";

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

export function MessengerPairing({ adapter, onClose, onConnected }: {
  adapter: "telegram" | "slack" | "discord";
  onClose: () => void;
  onConnected: () => void;
}) {
  const Flow = adapter === "telegram" ? ManagedTelegramOnboardingFlow : adapter === "slack" ? ManagedSlackOnboardingFlow : SharedDiscordOnboardingFlow;
  return <Flow dependencies={compactTelegramDependencies} onBack={onClose} onConnected={onConnected} />;
}
