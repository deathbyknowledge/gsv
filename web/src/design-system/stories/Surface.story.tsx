import type { ComponentChildren } from "preact";
import { Surface } from "../../app/components/ui/Surface";
import type { Story } from "../story";

const sample = (title: string, body: string) => (
  <>
    <div style={{ color: "var(--text-title)", fontSize: "12px", letterSpacing: "0.08em", marginBottom: "6px" }}>
      {title}
    </div>
    <div style={{ color: "var(--text-dim)", fontSize: "11px", lineHeight: 1.5 }}>{body}</div>
  </>
);

/** Fixed-width slot so each card has a consistent footprint in the catalog. */
const slot = (children: ComponentChildren) => (
  <div style={{ width: "210px" }}>{children}</div>
);

const story: Story = {
  title: "Surface",
  group: "Data Display",
  blurb: "square card / panel · emphasis levels · interactive · selected",
  render: () => (
    /* render on a --void backdrop so card-vs-background contrast is visible */
    <div
      class="ds-col"
      style={{ background: "var(--void)", padding: "20px", borderRadius: "8px" }}
    >
      <div class="ds-cell">
        <div class="ds-label">Elevation levels (on --void)</div>
        <div class="ds-row">
          {slot(
            <Surface level={0}>
              {sample("LEVEL 0", "Base panel. Sits flat in the console surface.")}
            </Surface>,
          )}
          {slot(
            <Surface level={1}>
              {sample("LEVEL 1", "Default square card with panel background and border.")}
            </Surface>,
          )}
          {slot(
            <Surface level={2}>
              {sample("LEVEL 2", "Emphasized panel with a stronger border, still flat.")}
            </Surface>,
          )}
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Interactive (hover emphasis)</div>
        <div class="ds-row">
          {slot(
            <Surface level={1} interactive>
              {sample("HOVER ME", "Interactive card with hover background and accent edge.")}
            </Surface>,
          )}
          {slot(
            <Surface as="button" level={1} interactive onClick={() => {}}>
              {sample("BUTTON CARD", "Rendered as a <button> for fully clickable cards.")}
            </Surface>,
          )}
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Flush interactive</div>
        <div class="ds-row">
          {slot(
            <Surface as="button" flush interactive onClick={() => {}}>
              {sample("FLUSH CELL", "A clickable structural surface without card chrome.")}
            </Surface>,
          )}
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Selected (e.g. register-mode cards)</div>
        <div class="ds-row">
          {slot(
            <Surface level={1} interactive>
              {sample("UNSELECTED", "One option in a selectable group.")}
            </Surface>,
          )}
          {slot(
            <Surface level={1} interactive selected>
              {sample("SELECTED", "Accent border, faint accent fill, and a soft glow.")}
            </Surface>,
          )}
        </div>
      </div>
    </div>
  ),
};

export default story;
