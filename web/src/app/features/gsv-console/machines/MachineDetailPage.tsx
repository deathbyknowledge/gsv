import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { ConsoleTarget } from "../domain/consoleModels";
import {
  iconForTarget,
  machineBlurb,
  machineDetailSections,
  statusForTarget,
  toneForTarget,
} from "./machinePresentation";

type MachineDetailPageProps = {
  onBack: () => void;
  target: ConsoleTarget;
};

export function MachineDetailPage({ onBack, target }: MachineDetailPageProps) {
  return (
    <ConsoleDetailPage
      icon={iconForTarget(target)}
      title={target.label}
      typeLabel="GSV · MACHINE"
      statusLabel={statusForTarget(target)}
      tone={toneForTarget(target)}
      blurb={machineBlurb(target)}
      parentLabel="MACHINES"
      sections={machineDetailSections(target)}
      onBack={onBack}
    />
  );
}
