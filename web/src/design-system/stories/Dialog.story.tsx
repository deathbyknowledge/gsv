import { Dialog } from "../../app/components/ui/Dialog";
import type { Story } from "../story";

const story: Story = {
  title: "Dialog",
  group: "Composite",
  blurb: "modal surface · title + optional back + close · bracket corners · scrollable body · wrap in .gsv-dialog-scrim",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default — hosts arbitrary content</div>
        <Dialog title="MODELS" width={420} onClose={() => {}}>
          <div class="gsv-listitem" style={{ color: "var(--text)", lineHeight: 1.7 }}>
            Any surface can live in the body. The panel here is shown inline; in
            the app it renders inside a fixed <code>.gsv-dialog-scrim</code>
            {" "}backdrop that closes on click.
          </div>
        </Dialog>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sub-view — back arrow + header status</div>
        <Dialog
          title="GLM 5 2"
          width={420}
          onBack={() => {}}
          onClose={() => {}}
          headerExtra={<span class="gsv-sublabel" style={{ color: "var(--online)" }}>SAVED</span>}
        >
          <div class="gsv-listitem" style={{ color: "var(--text)", lineHeight: 1.7 }}>
            The back affordance exits a drilled-in detail without closing the
            whole dialog; ✕ / Escape close it.
          </div>
        </Dialog>
      </div>
    </div>
  ),
};

export default story;
