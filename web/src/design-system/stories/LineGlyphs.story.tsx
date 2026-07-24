import {
  SpeakerOnGlyph,
  SpeakerOffGlyph,
  ArchiveFolderGlyph,
  ArrowLeftGlyph,
  CopyGlyph,
  FreeContextGlyph,
  ModelChipGlyph,
  MoreVerticalGlyph,
  PlusGlyph,
  TaskListGlyph,
} from "../../app/components/ui/lineGlyphs";
import { ReasoningGlyph } from "../../app/components/ui/ReasoningGlyph";
import type { ComponentChildren } from "preact";
import type { Story } from "../story";

const GLYPHS: { label: string; node: (size: number) => ComponentChildren }[] = [
  { label: "speaker-on", node: (s) => <SpeakerOnGlyph size={s} /> },
  { label: "speaker-off", node: (s) => <SpeakerOffGlyph size={s} /> },
  { label: "archive", node: (s) => <ArchiveFolderGlyph size={s} /> },
  { label: "free-context", node: (s) => <FreeContextGlyph size={s} /> },
  { label: "copy", node: (s) => <CopyGlyph size={s} /> },
  { label: "plus", node: (s) => <PlusGlyph size={s} /> },
  { label: "task-list", node: (s) => <TaskListGlyph size={s} /> },
  { label: "model-chip", node: (s) => <ModelChipGlyph size={s} /> },
  { label: "more-vertical", node: (s) => <MoreVerticalGlyph size={s} /> },
  { label: "arrow-left", node: (s) => <ArrowLeftGlyph size={s} /> },
  { label: "reasoning", node: (s) => <ReasoningGlyph size={s} /> },
];

const story: Story = {
  title: "Line glyphs",
  group: "Chrome",
  blurb: "Inline outline glyphs (crisp at small sizes) · speaker on/off · archive · free-context · copy · plus · task-list · model-chip · more-vertical · arrow-left · reasoning",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Glyphs · 16px</div>
        <div class="ds-row" style={{ gap: "22px", color: "var(--accent)" }}>
          {GLYPHS.map((g) => (
            <div key={g.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
              {g.node(16)}
              <div class="ds-label" style={{ fontSize: "8.5px" }}>{g.label}</div>
            </div>
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes · 12 / 16 / 24 / 32</div>
        <div class="ds-row" style={{ alignItems: "center", gap: "20px", color: "var(--accent)" }}>
          {[12, 16, 24, 32].map((s) => <FreeContextGlyph key={s} size={s} />)}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Speech toggle · on / off</div>
        <div class="ds-row" style={{ alignItems: "center", gap: "20px" }}>
          <span style={{ color: "var(--accent-bright)" }}><SpeakerOnGlyph size={18} /></span>
          <span style={{ color: "var(--text-dim)" }}><SpeakerOffGlyph size={18} /></span>
        </div>
      </div>
    </div>
  ),
};

export default story;
