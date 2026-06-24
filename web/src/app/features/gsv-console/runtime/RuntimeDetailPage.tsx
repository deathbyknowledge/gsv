import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { ConsoleProcess } from "../domain/consoleModels";
import {
  processBlurb,
  processDetailSections,
  statusForProcess,
  toneForProcess,
} from "./runtimePresentation";

type RuntimeDetailPageProps = {
  onBack: () => void;
  process: ConsoleProcess;
};

export function RuntimeDetailPage({ onBack, process }: RuntimeDetailPageProps) {
  return (
    <ConsoleDetailPage
      icon="list"
      title={process.label}
      typeLabel="GSV · TASK"
      statusLabel={statusForProcess(process)}
      tone={toneForProcess(process)}
      blurb={processBlurb(process)}
      parentLabel="RUNTIME"
      sections={processDetailSections(process)}
      onBack={onBack}
    />
  );
}
