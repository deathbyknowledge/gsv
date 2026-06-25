import { AgentEditor } from "../../app/components/ui/AgentEditor";
import { ConsoleHeader } from "../../app/components/ui/ConsoleHeader";

/** AgentDetail — the canonical GSV detail-page template. A console page on
 *  `var(--void)`: a breadcrumb ConsoleHeader (with its live pulsing dot + a
 *  right-aligned ship tag) sits atop a glyph-grid background texture, and the
 *  ported AgentEditor (manage mode, with its GENERAL / FILES / TASKS tabs and
 *  form atoms) is composed verbatim inside a framed, softly glowing panel as
 *  the page body. This is the reusable pattern for all other detail pages. */
export function AgentDetail() {
  return (
    <div
      style="position:relative;min-height:100%;background:var(--void);font-family:var(--gsv-font-mono);color:#cdd2e0;overflow:hidden;"
    >
      {/* glyph universe grid texture */}
      <div style="position:absolute;inset:0;pointer-events:none;z-index:0;background-image:linear-gradient(rgba(150,140,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(150,140,255,.04) 1px,transparent 1px);background-size:46px 46px;" />
      <div style="position:absolute;inset:0;pointer-events:none;z-index:0;font-family:var(--gsv-font-mono);">
        <span style="position:absolute;left:18%;top:14%;font-size:13px;color:#b6b1ff;opacity:.16;">✦</span>
        <span style="position:absolute;left:64%;top:9%;font-size:15px;color:#cdd5e6;opacity:.18;">∗</span>
        <span style="position:absolute;left:83%;top:33%;font-size:11px;color:#b6b1ff;opacity:.16;">·</span>
        <span style="position:absolute;left:43%;top:50%;font-size:10px;color:#cdd5e6;opacity:.2;">◦</span>
        <span style="position:absolute;left:23%;top:74%;font-size:12px;color:#b6b1ff;opacity:.14;">✦</span>
        <span style="position:absolute;left:72%;top:80%;font-size:13px;color:#cdd5e6;opacity:.16;">∗</span>
        <span style="position:absolute;left:91%;top:64%;font-size:9px;color:#cdd5e6;opacity:.22;">◦</span>
      </div>

      {/* ===== breadcrumb console header: GSV › SETTINGS › CREW › Xanadu ===== */}
      <div style="position:relative;z-index:2;">
        <ConsoleHeader
          crumbs={[
            { label: "GSV", onClick: () => {} },
            { label: "SETTINGS", onClick: () => {} },
            { label: "CREW", onClick: () => {} },
            { label: "Xanadu" },
          ]}
          tail="GSV · XANADU"
        />
      </div>

      {/* ===== framed panel — the AgentEditor as the page body ===== */}
      <div style="position:relative;z-index:2;padding:26px;">
        <div style="border:1px solid var(--border);background:var(--void);box-shadow:0 0 0 1px #060414,0 0 26px rgba(150,140,255,.12);">
          <AgentEditor mode="manage" containerWidth={1100} avatarSrc="img/agent-0.png" />
        </div>
      </div>
    </div>
  );
}
