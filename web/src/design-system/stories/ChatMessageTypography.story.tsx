import { Button } from "../../app/components/ui/Button";
import { MessageMeta } from "../../app/components/ui/MessageMeta";
import { SystemMessage } from "../../app/components/ui/SystemMessage";
import { Tag } from "../../app/components/ui/Tag";
import type { Story } from "../story";

/** One place to compare every chat message type against the shared scale:
 *  label 10px (.gsv-message-label) · paragraph 13px (.gsv-prose) · meta 12px
 *  (.gsv-sublabel). Colors differ per type; sizes must not. */

function TierNote() {
  return (
    <div class="gsv-sublabel" style={{ color: "var(--text-dim)", letterSpacing: "0.1em" }}>
      label 10px · paragraph 13px · meta 12px
    </div>
  );
}

const story: Story = {
  title: "Chat message typography",
  group: "Chrome",
  blurb: "user · assistant · system info · system error · approval — one scale, per-type colors",
  render: () => (
    <div class="ds-col" style={{ maxWidth: "480px" }}>
      <div class="ds-cell">
        <div class="ds-label">Scale</div>
        <TierNote />
      </div>

      <div class="ds-cell">
        <div class="ds-label">User (paragraph + meta)</div>
        <div style={{ border: "1px solid var(--rule-inner)", borderRadius: "14px", padding: "12px 14px" }}>
          <div class="gsv-prose">hey there, can you check what machines you can see?</div>
          <MessageMeta time="11:14 AM" onCopy={() => {}} />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Assistant (paragraph + meta)</div>
        <SystemMessage
          text="I can see two machines on this network. Both respond to ping."
          time="11:15 AM"
          onCopy={() => {}}
        />
      </div>

      <div class="ds-cell">
        <div class="ds-label">System info (3 rows: label / one-line text / meta)</div>
        <div style={{ borderLeft: "2px solid #2a2660", padding: "1px 0 1px 14px" }}>
          <div class="gsv-message-label" style={{ marginBottom: "5px", color: "var(--update)" }}>SYSTEM</div>
          <small class="gsv-prose" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#8f89ca" }}>
            Schedule event: nightly summary queued for every machine on the local network
          </small>
          <MessageMeta mirror time="11:15 AM" onCopy={() => {}} />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">System error (3 rows: label / Tag line / meta)</div>
        <div>
          <div class="gsv-message-label" style={{ marginBottom: "5px", color: "var(--update)" }}>SYSTEM</div>
          <Tag tone="error" label="Generation failed: error code: 1031" dot size="medium" />
          <MessageMeta mirror time="11:16 AM" onCopy={() => {}} />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Approval (label + paragraph + meta + link buttons)</div>
        <div>
          <div class="gsv-message-label" style={{ display: "flex", gap: "10px", color: "var(--update)", textTransform: "uppercase" }}>
            <span>APPROVAL REQUIRED</span>
            <strong style={{ fontWeight: 500 }}>SHELL</strong>
          </div>
          <p class="gsv-prose" style={{ margin: "7px 0 0", color: "var(--text-muted)" }}>
            input: targets list · target: gsv
          </p>
          <small class="gsv-sublabel" style={{ display: "block", marginTop: "6px", color: "var(--text-dim)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            SHELL.EXEC · REQUEST 4BD63EB2 · RUN 37FEEFA2
          </small>
          <div style={{ display: "flex", gap: "16px", justifyContent: "flex-end", marginTop: "10px" }}>
            <Button variant="link" tone="error" label="DENY" />
            <Button variant="link" tone="neutral" label="ALLOW ONCE" />
            <Button variant="link" tone="success" label="ALWAYS ALLOW" />
          </div>
        </div>
      </div>
    </div>
  ),
};

export default story;
