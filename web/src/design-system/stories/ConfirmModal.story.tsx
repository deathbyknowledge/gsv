import { ConfirmModal } from "../../app/components/ui/ConfirmModal";
import type { Story } from "../story";

const story: Story = {
  title: "ConfirmModal",
  group: "Composite",
  blurb: "destructive confirm · amber warning · secondary + danger buttons",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default</div>
        <ConfirmModal />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Custom copy & labels</div>
        <ConfirmModal
          title="REMOVE CREW MEMBER"
          message="Remove this agent from the current crew?"
          note="The agent stays on GSV — it just leaves this crew."
          cancelLabel="KEEP"
          confirmLabel="REMOVE"
        />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Narrow width (320)</div>
        <ConfirmModal width={320} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Wide width (560)</div>
        <ConfirmModal width={560} title="PURGE LOGS" message="Delete all archived logs for this agent?" />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Type-to-confirm guard (delete file)</div>
        <ConfirmModal
          title="DELETE FILE"
          message="Delete “/personas/captain.md” permanently?"
          note="Type the file path below to enable delete. This can’t be undone."
          confirmLabel="DELETE"
          confirmPhrase="/personas/captain.md"
          confirmInputLabel="TYPE PATH TO CONFIRM"
          confirmInputPlaceholder="/personas/captain.md"
        />
      </div>
    </div>
  ),
};

export default story;
