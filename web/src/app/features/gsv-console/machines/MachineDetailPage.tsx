import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
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
  deleteError?: string;
  deleting?: boolean;
  onBack: () => void;
  onDelete?: (target: ConsoleTarget) => void;
  target: ConsoleTarget;
};

export function MachineDetailPage({
  deleteError = "",
  deleting = false,
  onBack,
  onDelete,
  target,
}: MachineDetailPageProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmPhrase = target.deviceId;

  return (
    <>
      <ConsoleDetailPage
        actions={(
          <div class="gsv-console-detail-actions">
            <Button
              variant="dangerGhost"
              label={deleting ? "FORGETTING" : "FORGET MACHINE"}
              disabled={deleting || !onDelete || target.kind !== "native-device"}
              onClick={() => setConfirmDelete(true)}
            />
            {deleteError ? <span class="gsv-console-detail-action-error">{deleteError}</span> : null}
          </div>
        )}
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
      {confirmDelete ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmDelete(false)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="CONFIRM FORGET"
              message={`Forget machine "${target.label}"?`}
              note="The machine record is removed, any live device connection is disconnected, and active node tokens for this device are revoked."
              confirmLabel="FORGET MACHINE"
              confirmPhrase={confirmPhrase}
              confirmInputPlaceholder={confirmPhrase}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => {
                onDelete?.(target);
                setConfirmDelete(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
