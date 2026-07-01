import type { ComponentChildren } from "preact";
import { AuthLayout } from "../../app/features/session/AuthLayout";
import type { Story } from "../story";

// Framed viewport so the full-bleed (position:absolute inset:0) surface fills
// the frame rather than the page.
function Frame({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        position: "relative",
        height: "440px",
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: "2px",
      }}
    >
      {children}
    </div>
  );
}

function SamplePanel() {
  return (
    <div
      style={{
        width: "min(360px, 78%)",
        background: "color-mix(in srgb, var(--panel) 100%, #ffffff 5%)",
        border: "1px solid var(--border)",
        padding: "28px 26px",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
      <div class="gsv-paragraph" style={{ letterSpacing: "0.22em", color: "var(--text-title)" }}>PANEL SLOT</div>
      <div class="gsv-sublabel" style={{ letterSpacing: "0.06em", color: "var(--text-dim)", marginTop: "8px" }}>
        right-aligned content (login / setup wizard)
      </div>
    </div>
  );
}

const story: Story = {
  title: "AuthLayout",
  group: "Chrome",
  blurb: "auth surface · background variants (galaxy / stars / none) + right panel slot",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">background=&quot;galaxy&quot; · login &amp; register</div>
        <Frame>
          <AuthLayout background="galaxy">
            <SamplePanel />
          </AuthLayout>
        </Frame>
      </div>
      <div class="ds-cell">
        <div class="ds-label">background=&quot;stars&quot; · onboarding</div>
        <Frame>
          <AuthLayout background="stars">
            <SamplePanel />
          </AuthLayout>
        </Frame>
      </div>
      <div class="ds-cell">
        <div class="ds-label">background=&quot;none&quot;</div>
        <Frame>
          <AuthLayout background="none">
            <SamplePanel />
          </AuthLayout>
        </Frame>
      </div>
    </div>
  ),
};

export default story;
