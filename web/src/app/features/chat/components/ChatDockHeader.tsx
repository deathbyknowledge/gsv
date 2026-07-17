import { useEffect, useState } from "preact/hooks";
import { Avatar } from "../../../components/ui/Avatar";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { Progress } from "../../../components/ui/Progress";
import { StatusDot } from "../../../components/ui/StatusDot";
import { ArrowLeftGlyph, MoreVerticalGlyph, SpeakerOnGlyph, SpeakerOffGlyph } from "../../../components/ui/lineGlyphs";
import { Hint } from "../../../components/ui/Tooltip";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ChatAgentViewModel } from "../domain/agent";
import type { ChatConversation } from "../domain/processes";
import type { ChatPopoverId } from "./ChatDockPopovers";
import { shortId } from "./chatUiFormat";

type ChatDockHeaderProps = {
  activeAgent: ChatAgentViewModel;
  agentPanelOpen: boolean;
  atMax: boolean;
  canAbortRun: boolean;
  conversations: readonly ChatConversation[];
  activeConversationId: string;
  contextTone: "default" | "attention" | "error";
  contextPercent: number | null;
  contextTitle: string;
  effectiveStatus: StatusTone;
  hasActiveProcess: boolean;
  mobileLayout: boolean;
  /** Starting mobile view — catalog/story staging only; the app always starts
   *  on "primary". */
  initialMobileView?: MobileHeaderView;
  modelLabel: string;
  openPopover: ChatPopoverId | null;
  reasoningLabel: string;
  spawnPending: boolean;
  speakReplies: boolean;
  speechStatus: string;
  onAbortRun: () => void;
  onOpenAgentPanel: () => void;
  onStartProcess: () => void;
  onToggleSpeakReplies: () => void;
  onToggleMax: () => void;
  onToggleOpen: () => void;
  onTogglePopover: (popover: ChatPopoverId) => void;
};

/** The two mobile header views: `primary` shows the current task + model
 *  triggers, `more` the branch trigger + speech mode. Toggled by the ⋮/←
 *  button; desktop renders everything at once and never uses this. */
type MobileHeaderView = "primary" | "more";

const triggerChevron = (
  <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
    <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
  </svg>
);

export function ChatDockHeader({
  activeAgent,
  agentPanelOpen,
  atMax,
  canAbortRun,
  conversations,
  activeConversationId,
  contextTone,
  contextPercent,
  contextTitle,
  effectiveStatus,
  hasActiveProcess,
  mobileLayout,
  initialMobileView = "primary",
  modelLabel,
  openPopover,
  reasoningLabel,
  spawnPending,
  speakReplies,
  speechStatus,
  onAbortRun,
  onOpenAgentPanel,
  onStartProcess,
  onToggleSpeakReplies,
  onToggleMax,
  onToggleOpen,
  onTogglePopover,
}: ChatDockHeaderProps) {
  // Only the base "default" thread means there are no branches to choose between.
  const hasBranches = conversations.length > 1;
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const conversationLabel = activeConversation?.title
    || (activeConversationId === "default" ? "Default" : shortId(activeConversationId) || "Default");

  const [mobileView, setMobileView] = useState<MobileHeaderView>(initialMobileView);
  useEffect(() => {
    if (!mobileLayout) {
      setMobileView("primary");
    }
  }, [mobileLayout]);
  const onToggleMobileView = () => {
    // A view flip must not strand an expanded trigger out of the DOM — close
    // any open sheet first (togglePopover with the open id closes it).
    if (openPopover) {
      onTogglePopover(openPopover);
    }
    setMobileView((view) => view === "primary" ? "more" : "primary");
  };

  // Shared bare elements — the single source of truth for every class,
  // data-chat-popover-trigger and aria attribute. The desktop branch wraps
  // them in its Hints; the mobile branch places them in the two-view grid.
  // Either/or rendering keeps each trigger attribute unique in the DOM (the
  // dock positioner locates triggers by querySelector).
  const agentMain = (nameVisible: boolean) => (
    <button
      type="button"
      class="gsv-chat-agent-main"
      onClick={onOpenAgentPanel}
      aria-haspopup="dialog"
      aria-expanded={agentPanelOpen}
      aria-label={nameVisible ? undefined : `View ${activeAgent.name} profile`}
    >
      <span class="gsv-chat-avatar">
        <Avatar src={activeAgent.imageSrc} status={activeAgent.status} size={42} cover />
      </span>
      {nameVisible ? (
        <span class="gsv-chat-agent-name-row">
          <strong class="gsv-prose-heading">{activeAgent.name}</strong>
          {triggerChevron}
        </span>
      ) : null}
    </button>
  );

  const tasksTrigger = () => (
    <button
      type="button"
      class="gsv-chat-agent-activity gsv-sublabel"
      data-chat-popover-trigger="tasks"
      onClick={() => onTogglePopover("tasks")}
      aria-haspopup="menu"
      aria-expanded={openPopover === "tasks"}
    >
      <StatusDot tone={effectiveStatus} size={7} />
      <span>{activeAgent.activity}</span>
      <i aria-hidden="true" />
      {triggerChevron}
    </button>
  );

  const conversationsTrigger = () => (
    <button
      type="button"
      class="gsv-chat-agent-conversation gsv-sublabel"
      data-chat-popover-trigger="conversations"
      disabled={!hasBranches}
      onClick={() => onTogglePopover("conversations")}
      aria-haspopup="menu"
      aria-expanded={openPopover === "conversations"}
    >
      <span>{conversationLabel}</span>
      {triggerChevron}
    </button>
  );

  const modelTrigger = () => (
    <button
      type="button"
      class="gsv-chat-agent-model gsv-sublabel"
      data-chat-popover-trigger="model"
      onClick={() => onTogglePopover("model")}
      aria-haspopup="menu"
      aria-expanded={openPopover === "model"}
    >
      <span>{modelLabel}</span>
      <span>{reasoningLabel}</span>
      {triggerChevron}
    </button>
  );

  const contextControl = () => (
    <button
      type="button"
      class={`gsv-chat-context-control${contextTone !== "default" ? ` is-${contextTone}` : ""}`}
      data-chat-popover-trigger="context"
      onClick={() => onTogglePopover("context")}
      aria-haspopup="menu"
      aria-expanded={openPopover === "context"}
    >
      {contextPercent !== null ? (
        <>
          <Progress value={contextPercent} label="" showValue={false} size="medium" width={46} />
          <span>{`${contextPercent}%`}</span>
        </>
      ) : (
        <span class="gsv-chat-context-empty">Context</span>
      )}
    </button>
  );

  const startButton = () => !hasActiveProcess ? (
    <button
      type="button"
      class="gsv-chat-command gsv-chat-command-start"
      disabled={spawnPending}
      onClick={onStartProcess}
      aria-label="Start process"
    >
      <Icon name="plus" size={15} />
    </button>
  ) : null;

  const abortButton = () => canAbortRun ? (
    <button
      type="button"
      class="gsv-chat-command gsv-chat-command-abort"
      onClick={onAbortRun}
      aria-label="Abort current run"
    >
      <span aria-hidden="true" />
    </button>
  ) : null;

  const speechToggle = () => (
    <button
      type="button"
      class={`gsv-chat-command gsv-chat-command-speech${speakReplies ? " is-active" : ""}`}
      aria-label={speakReplies ? "Disable spoken replies" : "Enable spoken replies"}
      aria-pressed={speakReplies ? "true" : "false"}
      onClick={onToggleSpeakReplies}
    >
      {speakReplies ? <SpeakerOnGlyph size={15} /> : <SpeakerOffGlyph size={15} />}
    </button>
  );

  const start = startButton();
  const abort = abortButton();

  if (mobileLayout) {
    // Mobile: avatar-only agent block, two stacked trigger rows behind the
    // ⋮/← toggle, the conditional start/abort beside the toggle (toggle stays
    // far right), context as the compact cell below. Min/max are not rendered
    // — the shell's swipe/edge affordances close the drawer. speechStatus
    // doubles as the speech row's label: it carries the stable on/off wording
    // plus transient progress/failure strings.
    return (
      <header class="gsv-chat-head">
        <div class="gsv-chat-agent">
          {agentMain(false)}
          <div class="gsv-chat-m-rows">
            {mobileView === "primary" ? tasksTrigger() : conversationsTrigger()}
            {mobileView === "primary" ? modelTrigger() : (
              <button
                type="button"
                class={`gsv-chat-agent-speech gsv-sublabel${speakReplies ? " is-active" : ""}`}
                aria-pressed={speakReplies ? "true" : "false"}
                aria-label={speakReplies ? "Disable spoken replies" : "Enable spoken replies"}
                onClick={onToggleSpeakReplies}
              >
                {speakReplies ? <SpeakerOnGlyph size={15} /> : <SpeakerOffGlyph size={15} />}
                <span>{speechStatus}</span>
              </button>
            )}
          </div>
        </div>
        <div class="gsv-chat-actions">
          <div class="gsv-chat-m-cluster">
            {start ?? abort}
            <button
              type="button"
              class="gsv-chat-m-toggle"
              aria-label={mobileView === "primary" ? "Show more controls" : "Back to task and model"}
              onClick={onToggleMobileView}
            >
              {mobileView === "primary" ? <MoreVerticalGlyph size={18} /> : <ArrowLeftGlyph size={18} />}
            </button>
          </div>
          {contextControl()}
        </div>
      </header>
    );
  }

  return (
    <header class="gsv-chat-head">
      <div class="gsv-chat-agent">
        <Hint text="View agent profile & switch agents" position="bottom-start">
          {agentMain(true)}
        </Hint>
        <div class="gsv-chat-agent-meta-row">
          <Hint text="View activity & tasks" position="bottom-start">
            {tasksTrigger()}
          </Hint>
          <Hint text={hasBranches ? "Select conversation branch" : "Conversation branches will show up here"} position="bottom-start">
            {conversationsTrigger()}
          </Hint>
        </div>
        <Hint text="Change model & reasoning effort" position="bottom-start">
          {modelTrigger()}
        </Hint>
      </div>
      <div class="gsv-chat-actions">
        <div class="gsv-chat-action-row">
          {start ? (
            <Hint text="Start an interactive process" position="bottom-end">
              {start}
            </Hint>
          ) : null}
          <Hint text={speechStatus} position="bottom-end">
            {speechToggle()}
          </Hint>
          {abort ? (
            <Hint text="Abort the current run" position="bottom-end">
              {abort}
            </Hint>
          ) : null}
          <Hint text={atMax ? "Sidepanel view" : "Full width"} position="bottom-end">
            <IconButton glyph={atMax ? "sidepanel" : "max"} size="medium" ariaLabel={atMax ? "Sidepanel view" : "Expand chat"} onClick={onToggleMax} />
          </Hint>
          <Hint text="Minimize" position="bottom-end">
            <IconButton glyph="min" size="medium" ariaLabel="Minimize chat" onClick={onToggleOpen} />
          </Hint>
        </div>
        <Hint text={contextTitle} position="left">
          {contextControl()}
        </Hint>
      </div>
    </header>
  );
}
