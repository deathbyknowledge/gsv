import { useState } from "preact/hooks";
import { Button } from "../../app/components/ui/Button";
import {
  ContextSectionsEditor,
  type ContextSection,
} from "../../app/components/ui/ContextSectionsEditor";
import type { Story } from "../story";

const SEED: ContextSection[] = [
  { label: "About you", name: "10-about-you.md", content: "# About you\n\nName: Jessica\nRole: Captain" },
  { label: "Active projects", name: "20-active-projects.md", content: "# Active projects\n\n- GSV console\n- Nav IA" },
];

function EditorDemo({ initial, readOnly }: { initial: ContextSection[]; readOnly?: boolean }) {
  const [files, setFiles] = useState<ContextSection[]>(initial);
  const [active, setActive] = useState(0);
  return (
    <div style={{ maxWidth: 640 }}>
      <ContextSectionsEditor
        files={files}
        onChange={setFiles}
        activeIndex={active}
        onActiveIndexChange={setActive}
        readOnly={readOnly}
        actions={<Button variant="primary" label="SAVE" disabled />}
      />
    </div>
  );
}

const story: Story = {
  title: "Context Sections Editor",
  group: "Composite",
  blurb: "markdown context sections · file tabs + NEW SECTION · rename · content editor · per-section DELETE · host actions slot",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Sections (add / rename / delete)</div>
        <EditorDemo initial={SEED} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Empty (no sections yet)</div>
        <EditorDemo initial={[]} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Read-only</div>
        <EditorDemo initial={SEED} readOnly />
      </div>
    </div>
  ),
};

export default story;
