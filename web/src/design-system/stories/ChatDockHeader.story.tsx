import type { ComponentChildren } from "preact";
import { ChatDockHeader } from "../../app/features/chat/components/ChatDockHeader";
import type { ChatAgentViewModel } from "../../app/features/chat/domain/agent";
import type { ChatConversation } from "../../app/features/chat/domain/processes";
import type { Story } from "../story";

/** Mobile chat header — the two-view layout behind the ⋮/← toggle. Staged
 *  under a synthetic shell wrapper so the `.is-mobile` rules apply without the
 *  authed app: avatar-only agent block, 44px trigger rows, conditional
 *  start/abort beside the toggle, compact context cell. The ⋮ button is live —
 *  click it to flip views. Desktop reference at the bottom guards the shared
 *  helper refactor. */

const noop = () => {};

function mockAgent(overrides: Partial<ChatAgentViewModel> = {}): ChatAgentViewModel {
  return {
    id: "agent-friday",
    processId: "proc-1",
    runAs: "friday",
    name: "Friday",
    role: "Ship agent",
    description: "General systems vehicle attendant.",
    imageSrc: "/img/agent-0.png",
    status: "idle",
    statusLabel: "idle",
    activity: "Idle",
    modelLabel: "@CF/ZAI-ORG/GLM-5.2",
    modelOptions: [],
    modelProfiles: [],
    modelValue: "glm",
    modelIsDefault: true,
    reasoningLabel: "MEDIUM",
    permission: "default",
    tasksTotal: 0,
    tasks: [],
    crew: [],
    hasCrewData: false,
    ...overrides,
  };
}

function mockConversation(id: string, title: string | null, messageCount: number): ChatConversation {
  return {
    id,
    generation: 1,
    status: "open",
    title,
    messageCount,
    createdAt: 0,
    updatedAt: 0,
  };
}

const SINGLE_BRANCH = [mockConversation("default", null, 12)];
const MULTI_BRANCH = [
  mockConversation("default", null, 12),
  mockConversation("b-2", "Refactor plan", 4),
];

type VariantProps = Partial<Parameters<typeof ChatDockHeader>[0]>;

function headerProps(overrides: VariantProps = {}): Parameters<typeof ChatDockHeader>[0] {
  return {
    activeAgent: mockAgent(),
    agentPanelOpen: false,
    atMax: false,
    canAbortRun: false,
    conversations: SINGLE_BRANCH,
    activeConversationId: "default",
    contextTone: "default",
    contextPercent: 63,
    contextTitle: "Context 63% · healthy",
    effectiveStatus: "idle",
    hasActiveProcess: true,
    mobileLayout: true,
    modelLabel: "@CF/ZAI-ORG/GLM-5.2",
    openPopover: null,
    reasoningLabel: "MEDIUM",
    spawnPending: false,
    speakReplies: false,
    speechStatus: "Speech off",
    onAbortRun: noop,
    onOpenAgentPanel: noop,
    onStartProcess: noop,
    onToggleSpeakReplies: noop,
    onToggleMax: noop,
    onToggleOpen: noop,
    onTogglePopover: noop,
    ...overrides,
  };
}

/** Synthetic shell wrapper: positioned + sized so the mobile drawer rules
 *  (`.is-mobile .gsv-chat` is absolutely inset) render the header in-flow;
 *  the slide-in animation is disabled for a stable catalog frame. */
function MobileFrame({ children }: { children: ComponentChildren }) {
  return (
    <div class="gsv-shell-root" style={{ width: "375px" }}>
      <div class="gsv-shell-viewport is-mobile" style={{ position: "relative", height: "128px", overflow: "hidden" }}>
        <aside class="gsv-chat" style={{ animation: "none", width: "100%" }}>
          {children}
        </aside>
      </div>
    </div>
  );
}

const story: Story = {
  title: "Chat header (mobile)",
  group: "Chrome",
  blurb: "two views behind ⋮/← · avatar-only · 44px rows · conditional start/abort · compact context",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Primary view — running (abort beside ⋮), multi-branch, 82% attention</div>
        <MobileFrame>
          <ChatDockHeader {...headerProps({
            activeAgent: mockAgent({ status: "live", activity: "Reviewing diffs", statusLabel: "live" }),
            canAbortRun: true,
            conversations: MULTI_BRANCH,
            contextTone: "attention",
            contextPercent: 82,
            contextTitle: "Context 82% · elevated",
            effectiveStatus: "live",
          })} />
        </MobileFrame>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Primary view — idle (START beside ⋮), context null</div>
        <MobileFrame>
          <ChatDockHeader {...headerProps({
            hasActiveProcess: false,
            contextPercent: null,
            contextTitle: "No context yet",
          })} />
        </MobileFrame>
      </div>

      <div class="ds-cell">
        <div class="ds-label">More view — single branch (disabled), speech off</div>
        <MobileFrame>
          <ChatDockHeader {...headerProps({ initialMobileView: "more" })} />
        </MobileFrame>
      </div>

      <div class="ds-cell">
        <div class="ds-label">More view — multi-branch, speaking (transient status)</div>
        <MobileFrame>
          <ChatDockHeader {...headerProps({
            initialMobileView: "more",
            conversations: MULTI_BRANCH,
            speakReplies: true,
            speechStatus: "Speaking 2/5",
          })} />
        </MobileFrame>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Long activity text — truncates, cluster stays put</div>
        <MobileFrame>
          <ChatDockHeader {...headerProps({
            activeAgent: mockAgent({ activity: "Compiling a very long report about the state of every subsystem aboard" }),
            canAbortRun: true,
          })} />
        </MobileFrame>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Desktop reference — unchanged layout (helper-refactor guard)</div>
        <div class="gsv-shell-root" style={{ width: "440px" }}>
          <div class="gsv-shell-viewport" style={{ position: "relative", height: "132px", overflow: "hidden" }}>
            <aside class="gsv-chat" style={{ width: "440px", minWidth: 0, height: "100%" }}>
              <ChatDockHeader {...headerProps({
                mobileLayout: false,
                conversations: MULTI_BRANCH,
                canAbortRun: true,
                activeAgent: mockAgent({ status: "live", activity: "Reviewing diffs" }),
              })} />
            </aside>
          </div>
        </div>
      </div>
    </div>
  ),
};

export default story;
