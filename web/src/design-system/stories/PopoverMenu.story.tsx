import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { ArchiveFolderGlyph, FreeContextGlyph } from "../../app/components/ui/lineGlyphs";
import { ListRow } from "../../app/components/ui/ListRow";
import { PopoverMenu } from "../../app/components/ui/PopoverMenu";
import { Progress } from "../../app/components/ui/Progress";
import { TwoLevelSelect } from "../../app/components/ui/TwoLevelSelect";
import type { Story } from "../story";

/** Dock-width frame — the popover family renders at the width the chat header
 *  gives it. The host normally positions the shell absolutely (`.gsv-chat-popover`);
 *  in the static catalog we neutralize that so each variation flows in-place. */
function DockBox({ children }: { children: ComponentChildren }) {
  return <div style={{ width: "272px" }}>{children}</div>;
}

function ModelVariation() {
  const [reasoning, setReasoning] = useState("high");
  const [model, setModel] = useState("glm");
  return (
    <PopoverMenu
      className="ds-popover-static"
      ariaLabel="Model and reasoning"
      header={{ kind: "echo", label: "@CF/ZAI-ORG/GLM-5.2" }}
      actions={[{ label: "MANAGE MODELS", onClick: () => {} }]}
    >
      <TwoLevelSelect
        headerLabel="@CF/ZAI-ORG/GLM-5.2"
        header={false}
        roving={false}
        groups={[
          {
            id: "reasoning",
            label: "REASONING",
            options: ["off", "low", "medium", "high"].map((id) => ({
              id,
              label: id.toUpperCase(),
              selected: id === reasoning,
            })),
          },
          {
            id: "model",
            label: "SWITCH MODEL",
            options: [
              { id: "glm", label: "GLM-5.2", selected: model === "glm" },
              { id: "deepseek", label: "DEEPSEEK-V4-PRO", selected: model === "deepseek" },
              { id: "nemotron", label: "NEMOTRON-3-120B", selected: model === "nemotron" },
            ],
          },
        ]}
        onSelect={(groupId, optionId) => {
          if (groupId === "reasoning") {
            setReasoning(optionId);
          } else {
            setModel(optionId);
          }
        }}
      />
    </PopoverMenu>
  );
}

function TasksVariation() {
  return (
    <PopoverMenu
      className="ds-popover-static"
      ariaLabel="Current tasks"
      header={{ kind: "titled", title: "CURRENT TASKS", count: 3 }}
      actions={[
        { label: "NEW TASK", onClick: () => {}, icon: "plus" },
        { label: "OPEN TASKS", onClick: () => {}, icon: "list" },
      ]}
    >
      <div class="gsv-popover-list" style={{ maxHeight: "228px" }}>
        <ListRow density="compact" status="live" label="INDEX REBUILD" statusLabel="CURRENT" active onClick={() => {}} />
        <ListRow density="compact" status="live" label="NIGHTLY SYNC" statusLabel="RUNNING" onClick={() => {}} />
        <ListRow density="compact" status="error" label="LOG SHIP" statusLabel="ERROR" onClick={() => {}} />
      </div>
    </PopoverMenu>
  );
}

function ContextVariation() {
  return (
    <PopoverMenu
      className="ds-popover-static"
      ariaLabel="Context state"
      width="narrow"
      header={{ kind: "titled", title: "CONTEXT", count: "63% · HEALTHY" }}
      actions={[
        { label: "FREE CONTEXT · KEEP 20", onClick: () => {}, glyph: <FreeContextGlyph size={13} /> },
        { label: "ARCHIVED", onClick: () => {}, glyph: <ArchiveFolderGlyph size={13} /> },
      ]}
    >
      <div class="gsv-popover-meter">
        <Progress value={63} label="" showValue={false} size="medium" width={186} />
      </div>
      <div class="gsv-popover-statgrid">
        <span>INPUT</span>
        <strong>128.4K</strong>
        <span>AVAILABLE</span>
        <strong>71.6K</strong>
        <span>WINDOW</span>
        <strong>200K</strong>
        <span>MESSAGES</span>
        <strong>342</strong>
      </div>
    </PopoverMenu>
  );
}

function ConversationsVariation() {
  const [active, setActive] = useState("main");
  const branches = [
    { id: "main", label: "MAIN", messages: 342 },
    { id: "hotfix", label: "HOTFIX/AUTH-RETRY", messages: 28 },
    { id: "spike", label: "SPIKE/STREAMING", messages: 6 },
  ];
  return (
    <PopoverMenu
      className="ds-popover-static"
      ariaLabel="Conversation branches"
      header={{ kind: "titled", title: "BRANCHES", count: branches.length }}
    >
      <div class="gsv-popover-list" role="list" style={{ maxHeight: "min(288px, 44vh)" }}>
        {branches.map((branch) => (
          <ListRow
            key={branch.id}
            density="compact"
            status="none"
            label={branch.label}
            sub={`${branch.messages} messages`}
            statusLabel={branch.id === active ? "CURRENT" : ""}
            active={branch.id === active}
            onClick={() => setActive(branch.id)}
          />
        ))}
      </div>
    </PopoverMenu>
  );
}

const story: Story = {
  title: "PopoverMenu",
  group: "Composite",
  blurb: "chat-header popover family · titled/echo header · list body · link actions · roving focus",
  render: () => (
    <div class="ds-col">
      {/* The chat host positions these absolutely; flow them in-place for the catalog. */}
      <style>{".ds-popover-static.gsv-chat-popover{position:static !important}"}</style>
      <div class="ds-cell">
        <div class="ds-label">Model — echo header + TwoLevelSelect (headless) + MANAGE MODELS action</div>
        <DockBox>
          <ModelVariation />
        </DockBox>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Tasks — titled + count · compact rows · icon actions (arrow / Home / End rove)</div>
        <DockBox>
          <TasksVariation />
        </DockBox>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Context — titled + percent · narrow · meter + stat grid · glyph actions</div>
        <DockBox>
          <ContextVariation />
        </DockBox>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Conversations — titled + count · compact rows · CURRENT affordance</div>
        <DockBox>
          <ConversationsVariation />
        </DockBox>
      </div>
    </div>
  ),
};

export default story;
