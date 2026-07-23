import type { ComponentChildren } from "preact";
import { ObjectCard } from "../../app/components/ui/ObjectCard";
import { ListRow } from "../../app/components/ui/ListRow";
import { Tag } from "../../app/components/ui/Tag";
import { Icon } from "../../app/components/ui/Icon";
import type { Story } from "../story";

// ── Example data ────────────────────────────────────────────────────────────
// APPLICATIONS now lists two kinds: native GSV surfaces (fixed presentation —
// eyebrow "APPLICATION · GSV", status "SYSTEM") and imported web packages pulled from
// a source repo. FILES stands in for the native side; Weather + Notes for the
// external side (one PUBLIC, one PRIVATE) so every variant shows real-ish data.
type ExtApp = {
  name: string;
  repo: string;
  isPublic: boolean;
  chip: string;
  blurb: string;
};

const FILES_BLURB = "Browse and manage the ship's filesystem. A native GSV surface.";

const WEATHER: ExtApp = {
  name: "WEATHER",
  repo: "team/weather",
  isPublic: true,
  chip: "WE",
  blurb: "Local forecast and radar for the crew. Pulls NWS data every 10 minutes.",
};

const NOTES: ExtApp = {
  name: "NOTES",
  repo: "jessi/notes",
  isPublic: false,
  chip: "NO",
  blurb: "Personal scratch notes in Markdown, synced to a private repo.",
};

const EXTERNAL_APPS: ExtApp[] = [WEATHER, NOTES];

// ── Small composition helpers (story-local; no component edits) ──────────────

/** The native FILES product icon (folder). Fresh node per call. */
function folderIcon() {
  return <Icon name="folder" size={20} color="var(--accent-bright)" />;
}

/** 2-letter identity chip — the fallback glyph an imported package gets when it
 *  ships no icon of its own. Sizeable so it can sit in a card head (26) or a
 *  list-row leading slot (30). */
function chip(text: string, px = 26) {
  return (
    <span
      style={{
        width: `${px}px`,
        height: `${px}px`,
        flex: "none",
        borderRadius: "3px",
        background: "#171436",
        border: "1px solid var(--border)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--accent)",
        fontFamily: "var(--gsv-font-mono)",
        fontSize: `${Math.round(px * 0.42)}px`,
        letterSpacing: "0.04em",
      }}
    >
      {text}
    </span>
  );
}

/** Corner "EXTERNAL" marker for variant D — a sibling of the (overflow:hidden)
 *  card, sitting over its top border. */
function cornerMark(label: string) {
  return (
    <span
      style={{
        position: "absolute",
        top: "-8px",
        right: "12px",
        zIndex: 1,
        background: "var(--panel)",
        border: "1px solid var(--border-raised)",
        color: "var(--accent-bright)",
        fontFamily: "var(--gsv-font-mono)",
        fontSize: "8.5px",
        letterSpacing: "0.16em",
        padding: "2px 6px",
      }}
    >
      {label}
    </span>
  );
}

/** Dashed / transparent frame for variant B. External items get the dashed
 *  "non-native" affordance (var(--dashed)); natives get a matching transparent
 *  box so the two columns stay aligned. `block` switches inline-block (tiles)
 *  vs block (rows). */
function framed(node: ComponentChildren, external: boolean, block = false) {
  return (
    <div
      style={{
        display: block ? "block" : "inline-block",
        border: external ? "1px dashed var(--dashed)" : "1px solid transparent",
        padding: block ? "3px" : "4px",
      }}
    >
      {node}
    </div>
  );
}

/** Variant heading + one-line rationale. */
function variantHead(id: string, name: string, rationale: string) {
  return (
    <>
      <div
        style={{
          fontFamily: "var(--gsv-font-mono)",
          fontSize: "0.8125rem",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--accent-bright)",
        }}
      >
        {id} · {name}
      </div>
      <p class="gsv-prose-sm" style={{ margin: "6px 0 16px", color: "var(--text-muted)", maxWidth: "680px" }}>
        {rationale}
      </p>
    </>
  );
}

const repoLineStyle = { color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "none" as const };

// ── Variant renderers ────────────────────────────────────────────────────────

/** A — Eyebrow: typography only. The eyebrow reads "EXTERNAL · WEB UI" and the
 *  row sub names the source repo. */
function variantA() {
  return (
    <div class="ds-cell">
      {variantHead(
        "A",
        "Eyebrow",
        "Typography only — the eyebrow reads “EXTERNAL · WEB UI” against the native “APPLICATION · GSV”, and the list-row sub names the source repo. No new chrome: cheapest to ship, softest at a glance.",
      )}
      <div class="ds-label">Object strip · desktop</div>
      <div class="ds-row" style={{ alignItems: "flex-start" }}>
        <ObjectCard width={236} label="FILES" type="APPLICATION · GSV" status="online" icon={folderIcon()} blurb={FILES_BLURB} />
        {EXTERNAL_APPS.map((app) => (
          <ObjectCard key={app.name} width={236} label={app.name} type="EXTERNAL · WEB UI" glyph="applications" status="online" blurb={app.blurb} />
        ))}
      </div>
      <div class="ds-label" style={{ marginTop: "20px" }}>List rows</div>
      <div class="ds-col" style={{ maxWidth: "560px", gap: "10px" }}>
        <ListRow icon="folder" label="FILES" status="online" statusLabel="SYSTEM" sub="APPLICATION · GSV" />
        {EXTERNAL_APPS.map((app) => (
          <ListRow key={app.name} icon="satellite" label={app.name} status="online" statusLabel="ENABLED" sub={`EXTERNAL · ${app.repo}`} />
        ))}
      </div>
    </div>
  );
}

/** B — Dashed frame: reuses the dashed "non-native / add" affordance as a frame
 *  around the whole tile/row. */
function variantB() {
  return (
    <div class="ds-cell">
      {variantHead(
        "B",
        "Dashed frame",
        "Reuses the dashed “non-native / add” affordance (var(--dashed)) as a frame around the whole tile/row. Strong glanceable signal in the console's own visual language, but adds weight to every external item.",
      )}
      <div class="ds-label">Object strip · desktop</div>
      <div class="ds-row" style={{ alignItems: "flex-start" }}>
        {framed(<ObjectCard width={236} label="FILES" type="APPLICATION · GSV" status="online" icon={folderIcon()} blurb={FILES_BLURB} />, false)}
        {EXTERNAL_APPS.map((app) => (
          <span key={app.name}>{framed(<ObjectCard width={236} label={app.name} type="WEB UI" glyph="applications" status="online" blurb={app.blurb} />, true)}</span>
        ))}
      </div>
      <div class="ds-label" style={{ marginTop: "20px" }}>List rows</div>
      <div class="ds-col" style={{ maxWidth: "560px", gap: "10px" }}>
        {framed(<ListRow icon="folder" label="FILES" status="online" statusLabel="SYSTEM" sub="APPLICATION · GSV" />, false, true)}
        {EXTERNAL_APPS.map((app) => (
          <span key={app.name}>{framed(<ListRow icon="satellite" label={app.name} status="online" statusLabel="ENABLED" sub={app.repo} />, true, true)}</span>
        ))}
      </div>
    </div>
  );
}

/** C — Provenance tag: a boxed EXTERNAL tag + a PUBLIC/PRIVATE tag from
 *  sourcePublic + the source repo. */
function provenanceCard(app: ExtApp) {
  // Mirrors the shipped strip: one provenance band (tags + ellipsized repo)
  // above the card — see .gsv-object-strip-prov in gsvShell.css.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "236px" }}>
      <div style={{ minHeight: "20px", display: "flex", gap: "6px", alignItems: "center", overflow: "hidden" }}>
        <Tag label="EXTERNAL" tone="info" boxed />
        <Tag label={app.isPublic ? "PUBLIC" : "PRIVATE"} tone={app.isPublic ? "online" : "idle"} boxed />
        <span
          class="gsv-sublabel"
          style={{ ...repoLineStyle, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
        >
          {app.repo}
        </span>
      </div>
      <ObjectCard width={236} label={app.name} type="APPLICATION · WEB UI" glyph="applications" status="online" blurb={app.blurb} />
    </div>
  );
}

function variantC() {
  return (
    <div class="ds-cell">
      {variantHead(
        "C",
        "Provenance tag · CHOSEN",
        "A boxed provenance cluster — an EXTERNAL tag plus a PUBLIC/PRIVATE tag derived from sourcePublic, and the source repo. Jessica's pick (2026-07-20), with one edit: only external applications are labeled — natives carry no tag, just an empty band so card tops stay aligned. This section mirrors what ships.",
      )}
      <div class="ds-label">Object strip · desktop</div>
      <div class="ds-row" style={{ alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "236px" }}>
          <div style={{ minHeight: "20px" }} />
          <ObjectCard width={236} label="FILES" type="APPLICATION · GSV" status="online" icon={folderIcon()} blurb={FILES_BLURB} />
        </div>
        {EXTERNAL_APPS.map((app) => (
          <span key={app.name}>{provenanceCard(app)}</span>
        ))}
      </div>
      <div class="ds-label" style={{ marginTop: "20px" }}>List rows</div>
      <div class="ds-col" style={{ maxWidth: "560px", gap: "10px" }}>
        <ListRow icon="folder" label="FILES" status="online" statusLabel="SYSTEM" sub={FILES_BLURB} />
        {EXTERNAL_APPS.map((app) => (
          <ListRow
            key={app.name}
            icon="satellite"
            label={app.name}
            status="online"
            statusLabel="ENABLED"
            sub={`${app.repo} · ${app.isPublic ? "PUBLIC" : "PRIVATE"}`}
            tag="EXTERNAL"
            tagTone="info"
          />
        ))}
      </div>
    </div>
  );
}

/** D — Icon chip: swaps the generic satellite glyph for the package's own
 *  2-letter identity chip and pins a corner EXTERNAL marker. */
function chipCard(app: ExtApp) {
  return (
    <div style={{ position: "relative", width: "236px" }}>
      {cornerMark("EXTERNAL")}
      <ObjectCard width={236} label={app.name} type="WEB UI" status="online" icon={chip(app.chip, 26)} blurb={app.blurb} />
    </div>
  );
}

function variantD() {
  return (
    <div class="ds-cell">
      {variantHead(
        "D",
        "Icon chip",
        "Swaps the generic satellite glyph for the package's own 2-letter identity chip and pins a corner EXTERNAL marker; natives keep their real product icon. Gives each imported app a face, while the marker still says “imported”. In the row the marker rides the tag slot.",
      )}
      <div class="ds-label">Object strip · desktop</div>
      <div class="ds-row" style={{ alignItems: "flex-start" }}>
        <div style={{ position: "relative", width: "236px" }}>
          <ObjectCard width={236} label="FILES" type="APPLICATION · GSV" status="online" icon={folderIcon()} blurb={FILES_BLURB} />
        </div>
        {EXTERNAL_APPS.map((app) => (
          <span key={app.name}>{chipCard(app)}</span>
        ))}
      </div>
      <div class="ds-label" style={{ marginTop: "20px" }}>List rows</div>
      <div class="ds-col" style={{ maxWidth: "560px", gap: "10px" }}>
        <ListRow icon="folder" label="FILES" status="online" statusLabel="SYSTEM" sub="APPLICATION · GSV" />
        {EXTERNAL_APPS.map((app) => (
          <ListRow
            key={app.name}
            leading={chip(app.chip, 30)}
            label={app.name}
            status="online"
            statusLabel="ENABLED"
            sub={app.repo}
            tag="EXTERNAL"
            tagTone="accent"
          />
        ))}
      </div>
    </div>
  );
}

const story: Story = {
  title: "External Application Tile",
  group: "Data Display",
  blurb: "candidate treatments to mark imported apps as distinct from native GSV surfaces",
  render: () => (
    <div class="ds-col" style={{ gap: "36px" }}>
      <p class="gsv-prose" style={{ margin: 0, color: "var(--text-muted)", maxWidth: "720px" }}>
        APPLICATIONS now holds two kinds of thing: native GSV surfaces (FILES, LIBRARY, TERMINAL, REPOS —
        eyebrow “APPLICATION · GSV”, status “SYSTEM”) and imported web packages pulled from a source
        repo. The native presentation is fixed; the open question is how to mark the <em>external</em> ones so
        they read as distinct at a glance — in both the desktop object strip (ObjectCard) and the console list
        (ListRow). Four candidates follow, each external tile/row shown beside its native FILES counterpart for
        contrast, across both contexts and with two real-ish apps (one PUBLIC, one PRIVATE).{" "}
        <strong style={{ color: "var(--text)" }}>Variant C was chosen (2026-07-20)</strong> — with the edit that
        only external applications get labeled; natives carry no tag. A, B and D are kept for the record.
      </p>
      {variantA()}
      {variantB()}
      {variantC()}
      {variantD()}
    </div>
  ),
};

export default story;
