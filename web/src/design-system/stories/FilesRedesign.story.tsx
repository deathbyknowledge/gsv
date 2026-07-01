import type { ComponentChildren } from "preact";
import { Breadcrumbs } from "../../app/components/ui/Breadcrumbs";
import { Button } from "../../app/components/ui/Button";
import { ConfirmModal } from "../../app/components/ui/ConfirmModal";
import { IconButton } from "../../app/components/ui/IconButton";
import { ListRow } from "../../app/components/ui/ListRow";
import { SectionHeader } from "../../app/components/ui/SectionHeader";
import { Select } from "../../app/components/ui/Select";
import { StatusDot } from "../../app/components/ui/StatusDot";
import { Tabs } from "../../app/components/ui/Tabs";
import { TextArea } from "../../app/components/ui/TextArea";
import { TextInput } from "../../app/components/ui/TextInput";
import type { Story } from "../story";

/* ---------------------------------------------------------------------------
 * FilesRedesign — a STATIC mockup of a proposed redesign for the Files page,
 * assembled entirely from real GSV design-system components for design review.
 *
 * This is placeholder data with no-op handlers — there is no backend, no real
 * Files-page logic, and no controlled state. Each component is fed fixed props
 * so the review reflects true component styling.
 *
 * Four labeled states are stacked vertically, each wrapped in a titled section.
 * ------------------------------------------------------------------------- */

const noop = () => {};

const MACHINE_OPTIONS = ["GSV (LOCAL)", "WORKSTATION", "EDGE-01", "+ ADD MACHINE"];

/** Shared surface frame for one Files screen (the raised console panel). */
function Panel({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-raised)",
        background: "var(--panel)",
        boxShadow: "inset 0 0 0 1px #060414, 0 0 30px rgba(80,70,180,.1)",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
      {children}
    </div>
  );
}

/** Top chrome row: machine Select on the left, refresh affordance on the right.
 *  An optional online StatusDot sits beside the Select (machine-selected state). */
function TopRow({ machineIndex, online }: { machineIndex: number; online?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "14px 20px",
        borderBottom: "1px solid var(--border)",
        background: "var(--header-bar)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
        <Select options={MACHINE_OPTIONS} value={machineIndex} size="small" width={220} onChange={noop} />
        {online ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <StatusDot tone="online" size={8} />
            <span class="gsv-sublabel" style={{ letterSpacing: ".14em", color: "var(--online)" }}>ONLINE</span>
          </span>
        ) : null}
      </div>
      {/* Refresh affordance. No dedicated refresh glyph exists on IconButton, so a
          small secondary Button carries the action. */}
      <div style={{ marginLeft: "auto" }}>
        <Button variant="secondary" label="REFRESH" onClick={noop} />
      </div>
    </div>
  );
}

/** Toolbar: search field grows on the left; CREATE NEW primary on the right. */
function Toolbar() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "14px 20px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <TextInput
          label=""
          placeholder="SEARCH FILES…"
          prefix="⌕"
          clearable
          size="small"
          value=""
          onChange={noop}
        />
      </div>
      <div style={{ flex: "none" }}>
        <Button variant="primary" label="CREATE NEW" onClick={noop} />
      </div>
    </div>
  );
}

/** A directory or file row. File rows get a trailing "open in new tab" affordance
 *  (IconButton max glyph reads as expand-to-tab). */
function FileRow({
  label,
  kind,
  sub,
  active,
}: {
  label: string;
  kind: "DIR" | "FILE";
  sub?: string;
  active?: boolean;
}) {
  const isDir = kind === "DIR";
  return (
    <div style={{ position: "relative", borderBottom: "1px solid var(--border)" }}>
      <ListRow
        icon={isDir ? "folder" : "pencil"}
        label={label}
        sub={sub}
        status="none"
        tag={kind}
        tagTone={isDir ? "accent" : "info"}
        chevron={isDir}
        active={active}
        onClick={noop}
        style={{ paddingRight: isDir ? "20px" : "56px" }}
      />
      {!isDir ? (
        <span
          style={{
            position: "absolute",
            right: "16px",
            top: "0",
            bottom: "0",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <IconButton glyph="max" size="small" title="Open in new tab" onClick={noop} />
        </span>
      ) : null}
    </div>
  );
}

/** Small uppercase mono caption above each state block. */
function StateBlock({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div style={{ marginBottom: "32px" }}>
      <div class="ds-label">{label}</div>
      {children}
    </div>
  );
}

/* --- STATE A — GSV LOCAL · NO MACHINES ----------------------------------- */
function StateA() {
  return (
    <Panel>
      <TopRow machineIndex={0} />
      <Tabs tabs={["BROWSER"]} value={0} onChange={noop} />
      <SectionHeader title="GSV LOCAL FILES" meta="Files stored in this GSV instance." divider />
      <div style={{ padding: "12px 20px 6px" }}>
        <Breadcrumbs
          items={[{ label: "GSV", onClick: noop }, { label: "home", onClick: noop }, { label: "jessicat" }]}
          onBack={noop}
          size="small"
        />
      </div>
      <Toolbar />
      <div>
        <FileRow label="context.d" kind="DIR" sub="4 items" />
        <FileRow label="skills.d" kind="DIR" sub="12 items" />
        <FileRow label="notes.md" kind="FILE" sub="2.1 KB" />
      </div>
    </Panel>
  );
}

/* --- STATE B — MACHINE SELECTED · BROWSING ------------------------------- */
function StateB() {
  return (
    <Panel>
      <TopRow machineIndex={1} online />
      {/* package.json is the italic preview (peek) tab. */}
      <Tabs tabs={["BROWSER", "README.md", "package.json"]} value={0} previewIndex={2} onChange={noop} />
      <div style={{ padding: "12px 20px 6px" }}>
        <Breadcrumbs
          items={[
            { label: "WORKSTATION", onClick: noop },
            { label: "Users", onClick: noop },
            { label: "jess", onClick: noop },
            { label: "project" },
          ]}
          onBack={noop}
          size="small"
        />
      </div>
      <Toolbar />
      <div>
        <FileRow label="src" kind="DIR" sub="38 items" />
        <FileRow label="README.md" kind="FILE" sub="6.4 KB" active />
        <FileRow label="package.json" kind="FILE" sub="1.2 KB" />
      </div>
    </Panel>
  );
}

/* --- STATE C — FILE OPEN · EDITOR ---------------------------------------- */
function StateC() {
  return (
    <Panel>
      <TopRow machineIndex={1} online />
      <Tabs tabs={["BROWSER", "README.md", "package.json"]} value={1} previewIndex={2} onChange={noop} />
      <div style={{ padding: "12px 20px 6px" }}>
        <Breadcrumbs
          items={[
            { label: "WORKSTATION", onClick: noop },
            { label: "jess", onClick: noop },
            { label: "project", onClick: noop },
            { label: "README.md" },
          ]}
          onBack={noop}
          size="small"
        />
      </div>

      {/* Editor header row: file path + actions. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "14px 20px",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          background: "var(--header-bar)",
        }}
      >
        <span class="gsv-label" style={{ letterSpacing: ".06em", color: "var(--text)", flex: "1 1 auto", minWidth: 0 }}>
          ~/project/README.md
        </span>
        <Button variant="secondary" label="SHOW FOLDER" onClick={noop} />
        <Button variant="danger" label="DELETE" onClick={noop} />
      </div>

      {/* Editor content. */}
      <div style={{ padding: "16px 20px" }}>
        <TextArea
          label=""
          rows={10}
          value={
            "# project\n\nA workstation project mounted over the GSV files bridge.\n\n## Getting started\n\n```\nnpm install\nnpm run dev\n```\n\n- src/      application source\n- package.json   manifest\n"
          }
          onChange={noop}
        />
      </div>

      {/* Editor footer: unsaved indicator on the left; RESET / SAVE on the right. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "14px 20px",
          borderTop: "1px solid var(--border)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flex: "1 1 auto" }}>
          <StatusDot tone="warn" size={8} />
          <span class="gsv-sublabel" style={{ letterSpacing: ".14em", color: "var(--warn)" }}>UNSAVED CHANGES</span>
        </span>
        <Button variant="secondary" label="RESET" onClick={noop} />
        <Button variant="primary" label="SAVE" onClick={noop} />
      </div>
    </Panel>
  );
}

/* --- STATE D — DELETE CONFIRMATION --------------------------------------- */
function StateD() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
      <ConfirmModal
        title="CONFIRM DELETE"
        message="Are you sure you want to delete “README.md”?"
        note="This file is removed from WORKSTATION — it can’t be recovered."
        cancelLabel="CANCEL"
        confirmLabel="DELETE"
        onCancel={noop}
        onConfirm={noop}
      />
    </div>
  );
}

const story: Story = {
  title: "Files redesign",
  group: "Templates",
  blurb: "proposed Files page · machine Select + Tabs (preview) + Breadcrumbs · browser, editor, delete states",
  render: () => (
    <div class="ds-template-frame">
      <div style={{ padding: "24px 20px", background: "var(--void)", minHeight: "100%" }}>
        <StateBlock label="State A — GSV Local · No Machines">
          <StateA />
        </StateBlock>
        <StateBlock label="State B — Machine Selected · Browsing">
          <StateB />
        </StateBlock>
        <StateBlock label="State C — File Open · Editor">
          <StateC />
        </StateBlock>
        <StateBlock label="State D — Delete Confirmation">
          <StateD />
        </StateBlock>
      </div>
    </div>
  ),
};

export default story;
