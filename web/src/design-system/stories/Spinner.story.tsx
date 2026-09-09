import { LoadingState, Spinner } from "../../app/components/ui/Spinner";
import type { Story } from "../story";

const story: Story = {
  title: "Spinner",
  group: "Feedback",
  blurb: "rotating wire sphere · inline and panel states · reduced motion",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-row">
          <Spinner size={12} />
          <Spinner size={18} />
          <Spinner size={22} />
          <Spinner size={32} />
          <Spinner size={48} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Inline status</div>
        <LoadingState>Reading instructions…</LoadingState>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Panel · dark</div>
        <div style="padding:16px;background:#07060f;color:#cbc7ff;--accent:#8071dd">
          <LoadingState variant="panel">Loading memory…</LoadingState>
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Panel · light</div>
        <div style="padding:16px;background:#f4f3fb;color:#4a4677;--accent:#6b5fd6">
          <LoadingState variant="panel">Loading your account…</LoadingState>
        </div>
      </div>
    </div>
  ),
};

export default story;
