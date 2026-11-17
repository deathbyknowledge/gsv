import type { ComponentChildren } from "preact";
import type { ConnectFlowShellProps } from "../../../components/connect-flow/ConnectFlowShell";
import type { ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import {
  useConfirmConsoleAdapterPairing,
  useConsoleAdapterPairingInfo,
  useCreateConsoleAdapterPairingLink,
  useDisconnectConsoleAdapterPairing,
  useInspectConsoleAdapterPairing,
} from "../../../services/system/useConsoleData";
import { SharedDiscordOnboardingFlow, ManagedSlackOnboardingFlow, ManagedTelegramOnboardingFlow, ManagedWhatsAppOnboardingFlow, type ManagedMessengerId, type ManagedTelegramDependencies } from "./messengers/ManagedTelegramOnboardingFlow";

/** Renders one step of a console connect flow inside our panel, without the console's page chrome. */
function CompactFlowShell({ flow, current, onStep }: ConnectFlowShellProps): ComponentChildren {
  const lastIndex = flow.steps.length - 1;
  const index = Math.max(0, Math.min(current, lastIndex));
  const step = flow.steps[index];
  return (
    <div class="settings-telegram-flow gsv-cf-step">
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
  useCreateConsoleAdapterPairingLink: () => useCreateConsoleAdapterPairingLink(),
  useDisconnectConsoleAdapterPairing: () => useDisconnectConsoleAdapterPairing(),
  useInspectConsoleAdapterPairing: () => useInspectConsoleAdapterPairing(),
  useConfirmConsoleAdapterPairing: () => useConfirmConsoleAdapterPairing(),
};

export function MessengerPairing({ adapter, disabled, onClose, onConnected, links, onRefreshLinks }: {
  adapter: ManagedMessengerId;
  disabled: boolean;
  onClose: () => void;
  onConnected: () => void;
  /** The owner's links, which a messenger that connects from a link watches for its new connection. */
  links?: readonly ConsoleIdentityLink[];
  onRefreshLinks?: () => void;
}) {
  const Flow = adapter === "telegram"
    ? ManagedTelegramOnboardingFlow
    : adapter === "slack"
      ? ManagedSlackOnboardingFlow
      : adapter === "whatsapp"
        ? ManagedWhatsAppOnboardingFlow
        : SharedDiscordOnboardingFlow;
  return <Flow dependencies={compactTelegramDependencies} disabled={disabled} onBack={onClose} onConnected={onConnected} links={links} onRefreshLinks={onRefreshLinks} />;
}
