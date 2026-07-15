import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  backupModelDetails,
  collectGroupEntries,
  collectRunEntries,
  findMessageById,
  reasoningText,
  toolActivityTitle,
  toolDetailSections,
  toolEntryTone,
  toolStatusLabel,
  type ChatDockMessage,
  type TranscriptActivityEntry,
} from "./ChatTranscript";
import { shortId } from "./chatUiFormat";
import "./ChatReasoningPanel.css";

/** What the reasoning panel is scoped to: one run's activity, one assistant
 *  reply's thinking (plus its run, when it has one), or — for activity groups
 *  that carry no run id — the group containing a message. */
export type ChatReasoningTarget =
  | { kind: "run"; runId: string }
  | { kind: "message"; messageId: string }
  | { kind: "group"; messageId: string };

type ChatReasoningPanelProps = {
  messages: readonly ChatDockMessage[];
  target: ChatReasoningTarget;
  onClose: () => void;
};

type PanelBlock =
  | { kind: "prose"; id: string; title: string; text: string }
  | { kind: "entry"; id: string; entry: TranscriptActivityEntry };

function stop(event: JSX.TargetedMouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function entryBlocks(entries: readonly TranscriptActivityEntry[]): PanelBlock[] {
  return entries.map((entry, index) => ({
    kind: "entry",
    id: `${entry.kind}:${entry.message.id}:${index}`,
    entry,
  }));
}

function PanelEntry({ entry }: { entry: TranscriptActivityEntry }) {
  const [expanded, setExpanded] = useState(false);

  if (entry.kind === "reasoning") {
    const text = reasoningText(entry.message);
    return (
      <div class="gsv-chat-rp-entry">
        <div class="gsv-chat-rp-entry-line">
          <strong class="gsv-prose">{entry.message.streaming ? "Thinking" : "Reasoned"}</strong>
        </div>
        {text ? <p class="gsv-chat-rp-prose gsv-prose-lead" onClick={stop}>{text}</p> : null}
      </div>
    );
  }

  if (entry.kind === "backup") {
    const details = entry.message.backupModel ? backupModelDetails(entry.message.backupModel) : "";
    return (
      <div class="gsv-chat-rp-entry">
        <div class="gsv-chat-rp-entry-line">
          <strong class="gsv-prose">Backup model used</strong>
        </div>
        {details ? <p class="gsv-chat-rp-prose gsv-prose-lead" onClick={stop}>{details}</p> : null}
      </div>
    );
  }

  const tool = entry.message;
  const tone = toolEntryTone(tool);
  const details = toolDetailSections(tool);
  return (
    <div class={`gsv-chat-rp-entry is-${tone}`}>
      <div class="gsv-chat-rp-entry-line">
        <strong class="gsv-prose">{toolActivityTitle(tool)}</strong>
        {details.length > 0 ? (
          <button
            type="button"
            class="gsv-chat-rp-detail-toggle gsv-sublabel"
            aria-expanded={expanded}
            onClick={(event) => {
              stop(event);
              setExpanded((value) => !value);
            }}
          >
            {expanded ? "HIDE DETAILS" : "DETAILS"}
          </button>
        ) : (
          <small class="gsv-chat-rp-entry-status gsv-sublabel">{toolStatusLabel(tool)}</small>
        )}
      </div>
      {expanded ? (
        <div class="gsv-chat-rp-detail" onClick={stop}>
          {details.map((section, index) => (
            <div class="gsv-chat-rp-detail-section" key={`${section.label}:${index}`}>
              <small class="gsv-sublabel">{section.label}</small>
              {section.body}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** ChatReasoningPanel — full-body reasoning view (HAM-360). Replaces the
 *  transcript + composer under the persistent chat header; plain text, no
 *  boxes. Clicking anywhere non-interactive returns to the chat. */
export function ChatReasoningPanel({ messages, target, onClose }: ChatReasoningPanelProps) {
  const backRef = useRef<HTMLButtonElement>(null);

  // Opening the panel unmounts whatever had focus — move it to the Back
  // button so the dialog is entered and announced.
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  const { blocks, label } = useMemo(() => {
    if (target.kind === "run") {
      return {
        blocks: entryBlocks(collectRunEntries(messages, target.runId)),
        label: `RUN ${shortId(target.runId)}`,
      };
    }
    if (target.kind === "group") {
      return {
        blocks: entryBlocks(collectGroupEntries(messages, target.messageId)),
        label: "RUN ACTIVITY",
      };
    }
    const message = findMessageById(messages, target.messageId);
    if (!message) {
      return { blocks: [] as PanelBlock[], label: "REASONING" };
    }
    const blocks: PanelBlock[] = [];
    const thinking = reasoningText(message);
    if (thinking) {
      blocks.push({ kind: "prose", id: `thinking:${message.id}`, title: "Reasoned", text: thinking });
    }
    if (message.runId) {
      blocks.push(...entryBlocks(collectRunEntries(messages, message.runId)));
    }
    return {
      blocks,
      label: message.runId ? `RUN ${shortId(message.runId)}` : "REASONING",
    };
  }, [messages, target]);

  return (
    <div
      class="gsv-chat-reasoning-panel"
      role="dialog"
      aria-label="Reasoning"
      onClick={onClose}
    >
      <div class="gsv-chat-rp-head">
        <button
          ref={backRef}
          type="button"
          class="gsv-chat-rp-back gsv-sublabel"
          onClick={(event) => {
            stop(event);
            onClose();
          }}
        >
          <i aria-hidden="true">‹</i>
          BACK TO CHAT
        </button>
        <span class="gsv-chat-rp-meta gsv-sublabel">
          {label}
          {blocks.length > 0 ? ` · ${blocks.length} ${blocks.length === 1 ? "ENTRY" : "ENTRIES"}` : ""}
        </span>
      </div>
      <div class="gsv-chat-rp-body">
        {blocks.length === 0 ? (
          <p class="gsv-chat-rp-empty gsv-prose">
            Reasoning is no longer available for this item — it may have been
            archived or belong to another conversation.
          </p>
        ) : blocks.map((block) => block.kind === "prose" ? (
          <div class="gsv-chat-rp-entry" key={block.id}>
            <div class="gsv-chat-rp-entry-line">
              <strong class="gsv-prose">{block.title}</strong>
            </div>
            <p class="gsv-chat-rp-prose gsv-prose-lead" onClick={stop}>{block.text}</p>
          </div>
        ) : (
          <PanelEntry entry={block.entry} key={block.id} />
        ))}
      </div>
    </div>
  );
}
