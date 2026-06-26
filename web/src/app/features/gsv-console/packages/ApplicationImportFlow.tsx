import { useEffect, useMemo } from "preact/hooks";
import { useUnsavedGuard, useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Select } from "../../../components/ui/Select";
import { Spinner } from "../../../components/ui/Spinner";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Stepper } from "../../../components/ui/Stepper";
import { Surface } from "../../../components/ui/Surface";
import { Tag } from "../../../components/ui/Tag";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import { useChatProcessHistory } from "../../chat/hooks/useChatProcesses";
import type { ChatHistoryMessage } from "../../chat/domain/processes";
import type { ConsoleAccount, ConsolePackage } from "../domain/consoleModels";
import { useConsoleAccounts } from "../hooks/useConsoleData";
import {
  APPLICATION_IMPORT_STEP_LABELS,
  applicationImportStepIndex,
  isConsoleApplicationPackage,
  isPackageImportDraftReady,
  packageCapabilitySummary,
  packageReviewLabel,
  packageSourceSummary,
  packageStatusLabel,
  packageStatusTone,
} from "./packageImportFlow";
import { usePackageImportFlow } from "./usePackageImportFlow";
import "./ApplicationImportFlow.css";

type ApplicationImportFlowProps = {
  onBack: () => void;
  onOpenPackage?: (pkg: ConsolePackage) => void;
  packages: readonly ConsolePackage[];
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function reviewerLabel(account: ConsoleAccount): string {
  const name = account.displayName || account.username;
  const relation = account.relation === "personal-agent"
    ? "PERSONAL AGENT"
    : account.relation.toUpperCase();
  return `${name} / ${relation}`;
}

function latestAssistantText(messages: readonly ChatHistoryMessage[] = []): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.text.trim()) {
      return message.text.trim();
    }
  }
  return "";
}

function reviewRunStatus(runState: string | undefined): { label: string; tone: "idle" | "live" | "update" | "warn" | "online" } {
  if (runState === "running") return { label: "RUNNING", tone: "live" };
  if (runState === "queued") return { label: "QUEUED", tone: "update" };
  if (runState === "awaiting_hil") return { label: "NEEDS APPROVAL", tone: "warn" };
  if (runState === "idle") return { label: "READY", tone: "online" };
  return { label: "PENDING", tone: "idle" };
}

function packageIcon(pkg: ConsolePackage): string {
  if (pkg.uiEntrypoints.length > 0 || pkg.runtime === "web-ui") {
    return "rss";
  }
  if (pkg.runtime === "node") {
    return "terminal";
  }
  return "pencil";
}

function packageReviewSub(pkg: ConsolePackage): string {
  return [
    packageCapabilitySummary(pkg),
    packageSourceSummary(pkg),
  ].filter(Boolean).join(" / ");
}

export function ApplicationImportFlow({
  onBack,
  onOpenPackage,
  packages,
}: ApplicationImportFlowProps) {
  const accounts = useConsoleAccounts();
  const flow = usePackageImportFlow({ knownPackages: packages });
  const reviewerAccounts = useMemo(
    () => accounts.accounts.filter((account) => account.runnable),
    [accounts.accounts],
  );
  const reviewerOptions = reviewerAccounts.length > 0
    ? reviewerAccounts.map(reviewerLabel)
    : ["PERSONAL AGENT"];
  const selectedReviewerIndex = Math.max(
    0,
    reviewerAccounts.findIndex((account) => account.username === flow.draft.reviewerUsername),
  );
  const reviewPid = flow.reviewProcess?.pid ?? "";
  const reviewHistory = useChatProcessHistory({
    args: { pid: reviewPid },
    enabled: reviewPid.length > 0,
  });
  const reviewText = latestAssistantText(reviewHistory.data?.messages ?? []);
  const reviewStatus = reviewRunStatus(reviewHistory.data?.runState);
  const reviewBusy = Boolean(flow.reviewProcess)
    && !reviewHistory.isError
    && (reviewHistory.data === undefined
      || reviewHistory.data.runState === "running"
      || reviewHistory.data.runState === "queued"
      || reviewHistory.data.runState === "awaiting_hil");
  const importedApplication = flow.importedPackage
    ? isConsoleApplicationPackage(flow.importedPackage)
    : true;
  const importReady = isPackageImportDraftReady(flow.draft);
  const canEnable = Boolean(flow.importedPackage)
    && !flow.importMutation.isPending
    && !flow.reviewMutation.isPending
    && !flow.enableMutation.isPending
    && (!flow.draft.includeReview || !reviewBusy);
  const importError = errorText(flow.importMutation.error);
  const reviewError = errorText(flow.reviewMutation.error);
  const enableError = errorText(flow.enableMutation.error);

  useUnsavedGuard(() =>
    !flow.enableMutation.isSuccess &&
    (flow.step !== "import" ||
      flow.draft.source.trim().length > 0 ||
      flow.draft.ref.trim() !== "main" ||
      flow.draft.subdir.trim() !== ".")
  );

  useEffect(() => {
    if (flow.draft.reviewerUsername || reviewerAccounts.length === 0) {
      return;
    }
    flow.updateDraft({ reviewerUsername: reviewerAccounts[0].username });
  }, [flow.draft.reviewerUsername, reviewerAccounts]);

  useEffect(() => {
    if (!reviewPid) {
      return;
    }
    const timer = window.setInterval(() => {
      void reviewHistory.refetch();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [reviewPid, reviewHistory.refetch]);

  // The wizard's own back controls unmount it like shell nav does, so route
  // them through the guard to prompt before discarding the import draft.
  const requestLeave = useUnsavedGuardLeave();
  const guardedBack = () => requestLeave(onBack);

  const openImportedPackage = (pkg: ConsolePackage | null) => {
    if (pkg && onOpenPackage) {
      onOpenPackage(pkg);
      return;
    }
    onBack();
  };

  const handleImport = () => {
    void flow.importApplication().catch(() => undefined);
  };

  const handleEnable = () => {
    void flow.enableImportedPackage()
      .then(openImportedPackage)
      .catch(() => undefined);
  };

  const renderImportStep = () => (
    <>
      <SectionHeader title="IMPORT PACKAGE" meta="STEP 1 / 2" divider />
      <div class="application-import-card-body">
        <p class="application-import-copy">Import a web UI package from a git source. The package is added disabled, then reviewed and enabled from the next step.</p>
        <div class="application-import-source-grid">
          <TextInput
            label="PUBLIC REPOSITORY"
            value={flow.draft.source}
            placeholder="https://github.com/team/package.git"
            clearable
            status={flow.draft.source.trim() ? "success" : "warning"}
            message={flow.draft.source.trim() ? "Source ready" : "Repository or remote URL required"}
            onChange={(source) => flow.updateDraft({ source })}
          />
          <TextInput
            label="REF"
            value={flow.draft.ref}
            placeholder="main"
            status="info"
            message="Branch, tag, or commit"
            onChange={(ref) => flow.updateDraft({ ref })}
          />
          <TextInput
            label="SUBDIRECTORY"
            value={flow.draft.subdir}
            placeholder="."
            status="info"
            message="Package root in the repo"
            onChange={(subdir) => flow.updateDraft({ subdir })}
          />
        </div>
        <div class="application-import-review-toggle">
          <Checkbox
            checked={flow.draft.includeReview}
            label="INCLUDE AGENT REVIEW"
            status={flow.draft.includeReview ? "success" : "warning"}
            message={flow.draft.includeReview ? "Recommended before enabling" : "Package will import without a spawned review"}
            onChange={(includeReview) => flow.updateDraft({ includeReview })}
          />
        </div>
        {flow.draft.includeReview ? (
          <div class="application-import-reviewer">
            <Select
              label="REVIEWER"
              options={reviewerOptions}
              value={selectedReviewerIndex}
              disabled={accounts.isLoading || reviewerAccounts.length === 0}
              width={360}
              status={reviewerAccounts.length > 0 ? "success" : "info"}
              message={reviewerAccounts.length > 0 ? "Review process will run as this agent" : "Default personal agent"}
              onChange={(index) => {
                const account = reviewerAccounts[index];
                flow.updateDraft({ reviewerUsername: account?.username ?? "" });
              }}
            />
          </div>
        ) : null}
        {importError ? <div class="application-import-inline-error" role="alert">{importError}</div> : null}
      </div>
      <footer class="application-import-card-actions">
        <Button variant="secondary" label="BACK TO APPLICATIONS" disabled={flow.importMutation.isPending} onClick={guardedBack} />
        <Button
          variant="primary"
          label={flow.importMutation.isPending ? "IMPORTING" : "IMPORT APPLICATION"}
          disabled={!importReady || flow.importMutation.isPending}
          onClick={handleImport}
        />
      </footer>
    </>
  );

  const renderReviewStep = () => {
    const pkg = flow.importedPackage;
    return (
      <>
        <SectionHeader title="REVIEW PACKAGE" meta="STEP 2 / 2" divider />
        <div class="application-import-card-body">
          {pkg ? (
            <div class="application-import-package-panel">
              <ListRow
                icon={packageIcon(pkg)}
                label={pkg.name}
                sub={packageReviewSub(pkg)}
                status={packageStatusTone(pkg)}
                statusLabel={packageStatusLabel(pkg)}
                statusDotPlacement="trailing"
                tag={isConsoleApplicationPackage(pkg) ? "APPLICATION" : "PACKAGE"}
                tagTone={isConsoleApplicationPackage(pkg) ? "accent" : "warn"}
              />
              <div class="application-import-package-meta">
                <Tag tone={pkg.reviewPending ? "update" : "online"} label={`REVIEW ${packageReviewLabel(pkg)}`} boxed />
                <Tag tone={pkg.sourcePublic ? "online" : "idle"} label={pkg.sourcePublic ? "PUBLIC SOURCE" : "PRIVATE SOURCE"} boxed />
                <Tag tone={importedApplication ? "accent" : "warn"} label={importedApplication ? "WEB UI" : "NO UI ENTRYPOINT"} boxed />
              </div>
            </div>
          ) : null}

          {!importedApplication ? (
            <div class="application-import-inline-info" role="status">
              This package imported successfully, but it does not declare a web UI entrypoint. It may appear under Library or Integrations instead of Applications.
            </div>
          ) : null}

          {flow.draft.includeReview ? (
            <div class="application-import-agent-review">
              <div class="application-import-agent-review-head">
                <StatusDot tone={flow.reviewMutation.isPending ? "live" : reviewStatus.tone} size={9} />
                <div>
                  <strong>AGENT REVIEW</strong>
                  <span>{flow.reviewProcess ? `${reviewStatus.label} / ${flow.reviewProcess.pid}` : "STARTING"}</span>
                </div>
                {flow.reviewMutation.isPending || reviewBusy ? <Spinner size={14} /> : null}
              </div>
              {flow.reviewProcess ? (
                <div class="application-import-review-process">
                  <span>{flow.reviewProcess.cwd || "review workspace"}</span>
                </div>
              ) : null}
              {reviewText ? (
                <TextArea
                  label="LATEST REVIEW NOTE"
                  value={reviewText}
                  rows={8}
                  readonly
                  status="info"
                  message="Generated by the review process"
                />
              ) : (
                <div class="application-import-review-empty">
                  {reviewBusy ? "Waiting for the review process to produce a verdict." : "No review message yet."}
                </div>
              )}
              {reviewError ? (
                <div class="application-import-inline-error" role="alert">{reviewError}</div>
              ) : null}
              {reviewError && pkg ? (
                <Button
                  variant="secondary"
                  label={flow.reviewMutation.isPending ? "STARTING" : "START REVIEW"}
                  disabled={flow.reviewMutation.isPending}
                  onClick={() => void flow.startReview().catch(() => undefined)}
                />
              ) : null}
            </div>
          ) : (
            <div class="application-import-inline-info" role="status">Agent review was skipped for this import.</div>
          )}

          {enableError ? <div class="application-import-inline-error" role="alert">{enableError}</div> : null}
        </div>
        <footer class="application-import-card-actions">
          <Button
            variant="secondary"
            label="BACK"
            disabled={flow.importMutation.isPending || flow.enableMutation.isPending}
            onClick={() => flow.setStep("import")}
          />
          <Button
            variant="secondary"
            label="IMPORT WITHOUT ENABLING"
            disabled={!pkg || flow.enableMutation.isPending}
            onClick={() => openImportedPackage(pkg)}
          />
          <Button
            variant="primary"
            label={flow.enableMutation.isPending ? "ENABLING" : pkg?.reviewPending ? "APPROVE & ENABLE" : "ENABLE"}
            disabled={!canEnable}
            onClick={handleEnable}
          />
        </footer>
      </>
    );
  };

  return (
    <section class="application-import">
      <div class="application-import-shell">
        <header class="application-import-head">
          <IconButton glyph="arrowBack" size="medium" title="Back to applications" onClick={guardedBack} />
          <div>
            <span class="application-import-kicker">SATELLITES / NEW APPLICATION</span>
            <h2>Add application</h2>
            <p>Import a package source, review the declared behavior, then enable it for the web UI.</p>
          </div>
          <Tag
            tone={flow.step === "review" ? (flow.importedPackage?.enabled ? "online" : "update") : "idle"}
            label={flow.step === "review" ? (flow.importedPackage?.enabled ? "ENABLED" : "IMPORTED") : "NOT IMPORTED"}
            boxed
            dot
          />
        </header>

        <div class="application-import-stepper" aria-label="Application import progress">
          <Stepper
            count={2}
            current={applicationImportStepIndex(flow.step)}
            l0={APPLICATION_IMPORT_STEP_LABELS[0]}
            l1={APPLICATION_IMPORT_STEP_LABELS[1]}
            width={360}
            size="small"
          />
        </div>

        <Surface class="application-import-card" level={2}>
          {flow.step === "review" ? renderReviewStep() : renderImportStep()}
        </Surface>

        <div class="application-import-footnote">
          <Icon name="weblink" size={13} />
          <span>Packages stay disabled until you enable them from the review step.</span>
        </div>
      </div>
    </section>
  );
}
