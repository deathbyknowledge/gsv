import { useEffect, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
import { TextInput } from "../../../components/ui/TextInput";
import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { PackageListKind } from "../domain/consoleListTypes";
import type { ConsolePackage } from "../domain/consoleModels";
import {
  launchableAppIdForPackage,
  packageDetailSections,
  packageListNoun,
  packageListTitle,
  packageSub,
  statusForPackage,
  toneForPackage,
} from "./packagePresentation";
import { usePackageLifecycleActions } from "./usePackageLifecycleActions";

type PackageDetailPageProps = {
  kind: PackageListKind;
  onBack: () => void;
  onOpenApp?: (appId: string, title?: string) => void;
  pkg: ConsolePackage;
};

export function PackageDetailPage({
  kind,
  onBack,
  onOpenApp,
  pkg,
}: PackageDetailPageProps) {
  const [confirmAction, setConfirmAction] = useState<"sync" | "checkout" | "remove" | null>(null);
  const [refDraft, setRefDraft] = useState(pkg.sourceRef || "main");
  const [refError, setRefError] = useState("");
  const lifecycle = usePackageLifecycleActions();
  const noun = packageListNoun(kind);
  const appId = launchableAppIdForPackage(pkg);
  const pending = lifecycle.enableMutation.isPending
    || lifecycle.syncMutation.isPending
    || lifecycle.checkoutMutation.isPending
    || lifecycle.removeMutation.isPending;
  const error = lifecycle.enableMutation.error
    ?? lifecycle.syncMutation.error
    ?? lifecycle.checkoutMutation.error
    ?? lifecycle.removeMutation.error
    ?? null;
  const enableLabel = lifecycle.enableMutation.isPending
    ? "ENABLING"
    : pkg.reviewPending
      ? "APPROVE + ENABLE"
      : "ENABLE PACKAGE";

  useEffect(() => {
    setRefDraft(pkg.sourceRef || "main");
    setRefError("");
  }, [pkg.packageId, pkg.sourceRef]);

  return (
    <>
      <ConsoleDetailPage
        actions={(
          <div class="gsv-console-detail-actions">
            {!pkg.enabled ? (
              <Button
                variant="success"
                label={enableLabel}
                disabled={pending}
                onClick={() => lifecycle.enableMutation.mutate(pkg)}
              />
            ) : null}
            <Button
              variant="secondary"
              label={lifecycle.syncMutation.isPending ? "REBUILDING" : "REBUILD"}
              disabled={pending}
              onClick={() => setConfirmAction("sync")}
            />
            <Button
              variant="secondary"
              label={lifecycle.checkoutMutation.isPending ? "CHANGING REF" : "CHANGE REF"}
              disabled={pending}
              onClick={() => {
                setRefDraft(pkg.sourceRef || "main");
                setRefError("");
                setConfirmAction("checkout");
              }}
            />
            {error ? <span class="gsv-console-detail-action-error">{error.message}</span> : null}
          </div>
        )}
        dangerAction={(
          <Button
            variant="dangerGhost"
            label={lifecycle.removeMutation.isPending ? "REMOVING" : "REMOVE PACKAGE"}
            disabled={pending}
            onClick={() => setConfirmAction("remove")}
          />
        )}
        icon={pkg.uiEntrypoints.length > 0 ? "stars" : "pencil"}
        title={pkg.name}
        typeLabel={`GSV · ${noun}`}
        statusLabel={statusForPackage(pkg)}
        tone={toneForPackage(pkg)}
        blurb={pkg.description || packageSub(pkg)}
        parentLabel={packageListTitle(kind)}
        primaryLabel={appId && onOpenApp ? "OPEN APP" : undefined}
        onPrimary={appId && onOpenApp ? () => onOpenApp(appId, pkg.name) : undefined}
        sections={packageDetailSections(pkg)}
        onBack={onBack}
      />
      {confirmAction ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmAction(null)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title={packageActionConfirmation(confirmAction).title}
              message={packageActionConfirmation(confirmAction, pkg).message}
              note={packageActionConfirmation(confirmAction).note}
              confirmLabel={packageActionConfirmation(confirmAction).confirmLabel}
              confirmPhrase={confirmAction === "remove" ? pkg.name : undefined}
              confirmInputPlaceholder={pkg.name}
              onCancel={() => setConfirmAction(null)}
              onConfirm={() => {
                if (confirmAction === "sync") {
                  lifecycle.syncMutation.mutate(pkg);
                  setConfirmAction(null);
                  return;
                }
                if (confirmAction === "remove") {
                  lifecycle.removeMutation.mutate(pkg);
                  setConfirmAction(null);
                  return;
                }
                const ref = refDraft.trim();
                if (!ref) {
                  setRefError("Source ref is required.");
                  return;
                }
                lifecycle.checkoutMutation.mutate({ package: pkg, ref });
                setConfirmAction(null);
              }}
            >
              {confirmAction === "checkout" ? (
                <TextInput
                  label="SOURCE REF"
                  value={refDraft}
                  clearable
                  status={refError ? "error" : "none"}
                  message={refError}
                  onChange={(value) => {
                    setRefDraft(value);
                    setRefError("");
                  }}
                />
              ) : null}
            </ConfirmModal>
          </div>
        </div>
      ) : null}
    </>
  );
}

function packageActionConfirmation(
  action: "sync" | "checkout" | "remove",
  pkg?: ConsolePackage,
): {
  confirmLabel: string;
  message: string;
  note: string;
  title: string;
} {
  if (action === "sync") {
    return {
      confirmLabel: "REBUILD",
      title: "CONFIRM REBUILD",
      message: `Rebuild "${pkg?.name ?? "this package"}" from its current source ref?`,
      note: "The package artifact is refreshed. If the source changed, review may be required before it can run again.",
    };
  }
  if (action === "checkout") {
    return {
      confirmLabel: "CHANGE REF",
      title: "CHANGE SOURCE REF",
      message: `Change the source ref for "${pkg?.name ?? "this package"}"?`,
      note: "The package is rebuilt from the new ref. Review may be required if the artifact changes.",
    };
  }
  return {
    confirmLabel: "REMOVE PACKAGE",
    title: "CONFIRM REMOVE",
    message: `Remove "${pkg?.name ?? "this package"}" from GSV?`,
    note: "The package is removed from the application list. Source repositories are not deleted.",
  };
}
