import { useState } from "preact/hooks";
import { TwoLevelSelect } from "../../app/components/ui/TwoLevelSelect";
import type { Story } from "../story";

function Demo() {
  const [reasoning, setReasoning] = useState("high");
  const [model, setModel] = useState("glm");
  return (
    <TwoLevelSelect
      headerLabel="@CF/ZAI-ORG/GLM-5.2"
      ariaLabel="Model and reasoning"
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
      footer={{ label: "MANAGE MODELS", onClick: () => {} }}
      onSelect={(groupId, optionId) => {
        if (groupId === "reasoning") {
          setReasoning(optionId);
        } else {
          setModel(optionId);
        }
      }}
    />
  );
}

const story: Story = {
  title: "TwoLevelSelect",
  group: "Forms",
  blurb: "grouped select · header echoes current value · check on selection · footer action",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Interactive (reasoning + switch model)</div>
        <div style={{ width: "300px", background: "var(--panel)", border: "1px solid var(--border-raised)" }}>
          <Demo />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Empty group + disabled options</div>
        <div style={{ width: "300px", background: "var(--panel)", border: "1px solid var(--border-raised)" }}>
          <TwoLevelSelect
            headerLabel="NO MODEL SELECTED"
            groups={[
              {
                id: "reasoning",
                label: "REASONING",
                options: ["off", "low"].map((id) => ({
                  id,
                  label: id.toUpperCase(),
                  disabled: true,
                })),
              },
              { id: "model", label: "SWITCH MODEL", options: [], emptyLabel: "NO SAVED MODELS" },
            ]}
            footer={{ label: "MANAGE MODELS", onClick: () => {} }}
            onSelect={() => {}}
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
