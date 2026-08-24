import type { ProcPromptBlock } from "@humansandmachines/gsv/protocol";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Select } from "../../../components/ui/Select";
import { TextArea } from "../../../components/ui/TextArea";
import { useUnsavedGuard, useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import {
  useConsoleProcesses,
  useConsolePromptInspection,
  useSaveConsolePromptSource,
} from "../hooks/useConsoleData";
import type { ConsoleProcess } from "../domain/consoleModels";
import "./PromptReviewPanel.css";

export function PromptReviewPanel() {
  const processQuery = useConsoleProcesses();
  const processes = useMemo(
    () => [...processQuery.processes]
      .sort(comparePromptProcesses),
    [processQuery.processes],
  );
  const [pid, setPid] = useState<string | null>(null);
  const selectedProcessIndex = Math.max(0, processes.findIndex((process) => process.pid === pid));

  useEffect(() => {
    if (pid && processes.some((process) => process.pid === pid)) {
      return;
    }
    setPid(processes[0]?.pid ?? null);
  }, [pid, processes]);

  const inspection = useConsolePromptInspection(pid);
  const blocks = inspection.data?.blocks ?? [];
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const selectedBlock = blocks.find((block) => block.id === selectedBlockId) ?? blocks[0] ?? null;
  const [sourceDraft, setSourceDraft] = useState("");
  const [saveError, setSaveError] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const saveSource = useSaveConsolePromptSource();
  const sourceDirty = selectedBlock?.source.editable === true
    && sourceDraft !== selectedBlock.source.text;
  const requestLeave = useUnsavedGuardLeave();
  useUnsavedGuard(() => sourceDirty);
  const selectProcess = (nextPid: string | null) => {
    if (nextPid !== pid) {
      requestLeave(() => setPid(nextPid));
    }
  };
  const selectBlock = (blockId: string) => {
    if (blockId !== selectedBlock?.id) {
      requestLeave(() => setSelectedBlockId(blockId));
    }
  };

  useEffect(() => {
    setSelectedBlockId((current) => blocks.some((block) => block.id === current)
      ? current
      : blocks[0]?.id ?? null);
  }, [inspection.dataUpdatedAt]);

  useEffect(() => {
    setSourceDraft(selectedBlock?.source.text ?? "");
    setSaveError("");
  }, [selectedBlock?.id, selectedBlock?.source.text]);

  if (processQuery.resource.isUnavailable) {
    return <PromptReviewState label="CONNECTION REQUIRED" />;
  }
  if (processQuery.resource.isLoading) {
    return <PromptReviewState label="LOADING PROCESSES" />;
  }
  if (processQuery.resource.isError) {
    return <PromptReviewState label={processQuery.resource.errorText || "PROCESS LIST FAILED"} tone="error" />;
  }
  if (!pid || processes.length === 0) {
    return <PromptReviewState label="NO PROCESS" />;
  }
  if (inspection.isLoading) {
    return <PromptReviewState label="ASSEMBLING NEXT-RUN PROMPT" />;
  }
  if (inspection.isError || !inspection.data) {
    return (
      <PromptReviewState
        label={inspection.error instanceof Error ? inspection.error.message : "PROMPT INSPECTION FAILED"}
        tone="error"
      />
    );
  }

  const data = inspection.data;
  const save = async () => {
    if (!selectedBlock?.source.editable || !sourceDirty) {
      return;
    }
    setSaveError("");
    try {
      await saveSource.mutateAsync({
        path: selectedBlock.source.path,
        content: sourceDraft,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div class="gsv-prompt-review" aria-label="Prompt review workspace">
      <header class="gsv-prompt-review-toolbar">
        <Select
          label="PROCESS"
          block
          options={processes.map(promptProcessOption)}
          value={selectedProcessIndex}
          onChange={(index) => selectProcess(processes[index]?.pid ?? null)}
        />
        <div class="gsv-prompt-review-stats" aria-label="Prompt size">
          <PromptStat label="BLOCKS" value={String(data.blocks.length)} />
          <PromptStat label="BYTES" value={formatCount(data.bytes)} />
          <PromptStat label="TOKENS · EST" value={formatCount(data.estimatedTokens)} />
          <PromptStat label="GENERATED" value={formatTime(data.generatedAt)} />
        </div>
        <div class="gsv-prompt-review-actions">
          <Button
            variant="secondary"
            label={showRaw ? "BLOCK VIEW" : "RAW PROMPT"}
            onClick={() => setShowRaw((current) => !current)}
          />
          <Button
            variant="secondary"
            label={inspection.isFetching ? "REFRESHING" : "REFRESH"}
            disabled={inspection.isFetching}
            onClick={() => requestLeave(() => void inspection.refetch())}
          />
        </div>
      </header>

      <p class="gsv-prompt-review-note gsv-paragraph-small">
        This is the exact prompt assembled for the next run. An active run keeps the prompt it started with.
      </p>

      {showRaw ? (
        <pre class="gsv-prompt-review-raw" data-testid="prompt-raw">{data.prompt}</pre>
      ) : (
        <div class="gsv-prompt-review-workspace">
          <nav class="gsv-prompt-review-outline" aria-label="Prompt blocks">
            {blocks.map((block) => (
              <button
                type="button"
                class={`gsv-prompt-review-outline-row is-${block.kind}${block.id === selectedBlock?.id ? " is-active" : ""}`}
                onClick={() => selectBlock(block.id)}
              >
                <span class="gsv-prompt-review-outline-kind">{block.label}</span>
                <strong>{block.name}</strong>
                <small>{formatCount(block.bytes)} B · ~{formatCount(block.estimatedTokens)} T</small>
              </button>
            ))}
          </nav>

          <main class="gsv-prompt-review-stream" aria-label="Assembled prompt blocks">
            {blocks.map((block) => (
              <button
                type="button"
                class={`gsv-prompt-review-block is-${block.kind}${block.id === selectedBlock?.id ? " is-active" : ""}`}
                onClick={() => selectBlock(block.id)}
              >
                <header>
                  <span>{block.label}</span>
                  <strong>{block.name}</strong>
                  <small>{block.provider}</small>
                </header>
                <pre>{block.rendered}</pre>
              </button>
            ))}
          </main>

          <aside class="gsv-prompt-review-source" aria-label="Selected prompt source">
            {selectedBlock ? (
              <>
                <div class="gsv-prompt-review-source-head">
                  <span class={`gsv-prompt-review-source-dot is-${selectedBlock.kind}`} aria-hidden="true" />
                  <div>
                    <strong>{selectedBlock.name}</strong>
                    <code>{selectedBlock.source.path}</code>
                  </div>
                </div>
                <dl class="gsv-prompt-review-meta">
                  <div><dt>SOURCE</dt><dd>{sourceKindLabel(selectedBlock)}</dd></div>
                  <div><dt>OUTPUT</dt><dd>{formatCount(selectedBlock.bytes)} bytes</dd></div>
                  <div><dt>ACCESS</dt><dd>{selectedBlock.source.editable ? "EDITABLE" : "READ ONLY"}</dd></div>
                </dl>
                <TextArea
                  label="SOURCE TEXT"
                  value={sourceDraft}
                  rows={18}
                  readonly={!selectedBlock.source.editable}
                  disabled={saveSource.isPending}
                  status={saveError ? "error" : "none"}
                  message={saveError}
                  onChange={selectedBlock.source.editable ? setSourceDraft : undefined}
                  textareaProps={{ "data-testid": "prompt-source" }}
                />
                {selectedBlock.source.text !== selectedBlock.rendered ? (
                  <details class="gsv-prompt-review-rendered">
                    <summary>RENDERED OUTPUT</summary>
                    <pre>{selectedBlock.rendered}</pre>
                  </details>
                ) : null}
                {selectedBlock.source.editable ? (
                  <div class="gsv-prompt-review-source-actions">
                    <Button
                      variant="secondary"
                      label="RESET"
                      disabled={!sourceDirty || saveSource.isPending}
                      onClick={() => setSourceDraft(selectedBlock.source.text)}
                    />
                    <Button
                      variant="primary"
                      label={saveSource.isPending ? "SAVING" : "SAVE SOURCE"}
                      disabled={!sourceDirty || saveSource.isPending}
                      onClick={() => void save()}
                    />
                  </div>
                ) : (
                  <p class="gsv-prompt-review-readonly gsv-paragraph-small">
                    Repository-defined system context and generated indexes are reviewed here, but edited at their owning source.
                  </p>
                )}
              </>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function comparePromptProcesses(left: ConsoleProcess, right: ConsoleProcess): number {
  return Number(right.personal) - Number(left.personal)
    || (right.lastActiveAt ?? right.createdAt ?? 0) - (left.lastActiveAt ?? left.createdAt ?? 0)
    || left.label.localeCompare(right.label);
}

function promptProcessOption(process: ConsoleProcess) {
  return {
    label: process.personal ? `PERSONAL · ${process.label}` : process.label,
    description: `${process.username} · ${process.pid}`,
  };
}

function sourceKindLabel(block: ProcPromptBlock): string {
  if (block.source.kind === "account-file") return "CONTEXT FILE";
  if (block.source.kind === "system-config") return "SYSTEM CONFIG";
  return "GENERATED";
}

function PromptStat({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><strong>{value}</strong></span>;
}

function PromptReviewState({ label, tone = "idle" }: { label: string; tone?: "error" | "idle" }) {
  return <div class={`gsv-prompt-review-state is-${tone}`}>{label}</div>;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
