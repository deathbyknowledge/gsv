import type { JSX } from "preact";
import { ConsoleHeader } from "../../app/components/ui/ConsoleHeader";
import { SectionHeader } from "../../app/components/ui/SectionHeader";
import { ListRow } from "../../app/components/ui/ListRow";
import { Icon } from "../../app/components/ui/Icon";
import { StatusDot } from "../../app/components/ui/StatusDot";

/**
 * ObjectDetail — console page template showing a single object (the Gmail
 * integration). Composes the ported atoms: ConsoleHeader breadcrumb, an
 * ObjectCard-style detail header (icon + name + status), a type micro-label, a
 * prose blurb, and SectionHeader + ListRow sections.
 *
 * Backdrop is `var(--void)` with the periwinkle glyph-grid texture (verbatim
 * from GSV Live.dc.html).
 */
export function ObjectDetail() {
  const pageStyle: JSX.CSSProperties = {
    position: "relative",
    minHeight: "100%",
    background: "radial-gradient(1100px 720px at 50% -4%,rgba(150,140,255,.07),transparent 58%),var(--void)",
    fontFamily: "var(--gsv-font-mono)",
    color: "var(--text)",
  };

  const gridStyle: JSX.CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundImage:
      "linear-gradient(rgba(150,140,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(150,140,255,.035) 1px,transparent 1px)",
    backgroundSize: "46px 46px",
  };

  return (
    <div style={pageStyle}>
      <div style={gridStyle} />

      <div style={{ position: "relative" }}>
        <ConsoleHeader
          crumbs={[{ label: "GSV" }, { label: "INTEGRATIONS" }, { label: "Gmail" }]}
          tail="GSV · INTEGRATIONS"
        />

        <div style={{ maxWidth: "760px", margin: "0 auto", padding: "30px 26px 48px" }}>
          {/* Detail header — icon + name + status dot */}
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <span
              style={{
                display: "flex",
                flex: "none",
                alignItems: "center",
                justifyContent: "center",
                width: "52px",
                height: "52px",
                background: "linear-gradient(180deg,#100e2a,var(--node-bg))",
                border: "1px solid var(--border)",
                color: "var(--accent-bright)",
                boxShadow: "0 6px 18px rgba(0,0,0,.45)",
              }}
            >
              <Icon name="gmail" size={26} color="var(--accent-bright)" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span
                  style={{
                    fontSize: "20px",
                    letterSpacing: ".08em",
                    fontWeight: 500,
                    color: "var(--text-hi)",
                    textShadow: "0 0 6px rgba(150,140,255,.4)",
                  }}
                >
                  Gmail
                </span>
                <StatusDot tone="online" size={8} />
                <span style={{ fontSize: "9px", letterSpacing: ".14em", color: "var(--online)" }}>ONLINE</span>
              </div>
              <div style={{ fontSize: "8px", letterSpacing: ".22em", color: "var(--text-dim)", marginTop: "8px" }}>
                INTEGRATION · MESSENGER
              </div>
            </div>
          </div>

          {/* Prose blurb */}
          <p
            style={{
              fontFamily: "var(--gsv-font-prose)",
              fontSize: "14px",
              lineHeight: 1.65,
              color: "#9089d4",
              margin: "20px 0 32px",
              textWrap: "pretty",
            }}
          >
            Reads and sends mail on behalf of the crew. The GSV uses this integration to triage the
            inbox, draft replies, and surface anything that needs a human. OAuth is scoped to send and
            read; the token refreshes silently and is revocable from this page.
          </p>

          {/* DETAILS section */}
          <div style={{ marginBottom: "26px" }}>
            <SectionHeader title="DETAILS" meta="OAUTH · v3" divider />
            <div style={{ border: "1px solid var(--border)", borderTop: "none" }}>
              <ListRow label="Account" status="none" sub="crew@gsv.example.com" />
              <ListRow label="Scopes" status="none" sub="gmail.send · gmail.readonly" />
              <ListRow label="Token" status="online" statusLabel="VALID" sub="Refreshed 12m ago" />
              <ListRow label="Connected" status="none" sub="2026-04-02 · 81 days ago" />
            </div>
          </div>

          {/* RECENT ACTIVITY section */}
          <div>
            <SectionHeader title="RECENT ACTIVITY" meta="LAST 24H" divider />
            <div style={{ border: "1px solid var(--border)", borderTop: "none" }}>
              <ListRow label="Sent reply to <re: Q2 budget>" status="online" statusLabel="OK" chevron />
              <ListRow label="Drafted 3 replies for review" status="online" statusLabel="OK" chevron />
              <ListRow label="Token refresh" status="online" statusLabel="OK" />
              <ListRow label="Rate limit hit · backed off" status="error" statusLabel="WARN" chevron />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
