import type { JSX } from "preact";
import { ConsoleHeader } from "../../app/components/ui/ConsoleHeader";
import { SectionHeader } from "../../app/components/ui/SectionHeader";
import { ListRow } from "../../app/components/ui/ListRow";
import type { ListRowStatus } from "../../app/components/ui/ListRow";
import { StatusDot } from "../../app/components/ui/StatusDot";
import type { StatusTone } from "../../app/components/ui/StatusDot";
import { Tag } from "../../app/components/ui/Tag";
import type { TagTone } from "../../app/components/ui/Tag";
import { Icon } from "../../app/components/ui/Icon";
import { AddAction } from "../../app/components/ui/AddAction";

interface MachineRow {
  name: string;
  sub: string;
  status: ListRowStatus;
  statusLabel: string;
  /** Right-aligned status dot tone. */
  tone: StatusTone;
  tag?: string;
  tagTone?: TagTone;
}

// Self-contained seed data — modeled on PAGE_DEFS.machines in GSV Live.dc.html,
// extended to ~6 realistic hosts for the list page.
const MACHINES: MachineRow[] = [
  {
    name: "<HANK-LINUX>",
    sub: "linux · x86_64 · last seen 2m ago",
    status: "online",
    statusLabel: "ONLINE",
    tone: "online",
  },
  {
    name: "<KAWAH-OILMACHINE>",
    sub: "linux · aarch64 · last seen 41m ago",
    status: "idle",
    statusLabel: "IDLE",
    tone: "idle",
  },
  {
    name: "<LIGER-RENDER>",
    sub: "linux · x86_64 · 64 cores · last seen 12s ago",
    status: "online",
    statusLabel: "ONLINE",
    tone: "online",
  },
  {
    name: "<BOB-MACMINI>",
    sub: "darwin · arm64 · update available",
    status: "online",
    statusLabel: "ONLINE",
    tone: "online",
    tag: "UPDATE",
    tagTone: "update",
  },
  {
    name: "<ESTEVO-EDGE>",
    sub: "linux · armv7 · last seen 3h ago",
    status: "idle",
    statusLabel: "IDLE",
    tone: "idle",
  },
  {
    name: "<XANADU-GPU>",
    sub: "linux · x86_64 · connection lost",
    status: "error",
    statusLabel: "OFFLINE",
    tone: "error",
  },
];

const rootStyle: JSX.CSSProperties = {
  minHeight: "100%",
  background: "var(--void)",
  fontFamily: "var(--gsv-font-mono)",
};

/** SettingsList — GSV "Settings List" page template. A single-category object
 *  list (MACHINES) composed of already-ported console atoms: a breadcrumb
 *  ConsoleHeader, a SectionHeader bar, a full-width list of ListRows (each with
 *  a dot-matrix Icon, name, sub-label, a right-aligned Tag/StatusDot and a
 *  trailing chevron), capped with an AddAction row. */
export function SettingsList() {
  return (
    <div style={rootStyle}>
      <ConsoleHeader
        crumbs={[
          { label: "GSV", notLast: true },
          { label: "SETTINGS", notLast: true },
          { label: "MACHINES" },
        ]}
        tail="GSV · CONTROL"
      />

      <SectionHeader title="MACHINES · 2 HOSTS" />

      <div>
        {MACHINES.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                flex: "none",
                color: "var(--accent)",
                paddingLeft: "20px",
              }}
            >
              <Icon name="computer" size={18} title="machine" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ListRow label={m.name} sub={m.sub} status="none" />
            </div>
            {m.tag ? (
              <span style={{ flex: "none", paddingRight: "12px" }}>
                <Tag tone={m.tagTone ?? "update"} label={m.tag} boxed />
              </span>
            ) : null}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "9px",
                flex: "none",
                paddingRight: "20px",
              }}
            >
              <span class="gsv-sublabel" style={{ letterSpacing: ".12em", color: "var(--text-dim)" }}>{m.statusLabel}</span>
              <StatusDot tone={m.tone} size={8} />
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                <svg width="9" height="12" viewBox="0 0 9 12" style={{ filter: "drop-shadow(0 0 3px rgba(150,140,255,.5))" }}>
                  <path d="M0 0 L9 6 L0 12 Z" fill="var(--accent)" />
                </svg>
              </span>
            </span>
          </div>
        ))}
      </div>

      <div style={{ padding: "16px 20px" }}>
        <AddAction variant="row" label="CONNECT NEW MACHINE" />
      </div>
    </div>
  );
}
