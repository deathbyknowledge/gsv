import type { Story } from "../story";

const lines = Array.from({ length: 16 }, (_, i) => i + 1);

const story: Story = {
  title: "Scrollbar",
  group: "Foundations",
  blurb: "branded thin accent scrollbar · .gsv-scroll utility (auto inside .gsv-auth-theme surfaces)",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Vertical scroll · .gsv-scroll</div>
        <div
          class="gsv-scroll"
          style={{
            maxHeight: "150px",
            overflowY: "auto",
            width: "320px",
            border: "1px solid var(--border)",
            background: "var(--panel-2)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "9px",
          }}
        >
          {lines.map((n) => (
            <div
              key={n}
              class="gsv-label"
              style={{
                letterSpacing: "0.04em",
                color: "var(--text)",
              }}
            >
              Scrollable line {n}
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
