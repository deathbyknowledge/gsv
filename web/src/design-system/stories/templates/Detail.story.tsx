import type { Story } from "../../story";
import { Wire, WireRow, WireBox, WireRepeat, PreviewLink } from "../../wireframe";

/** DETAIL archetype — a single object's detail view: page header (title +
 *  status), an action bar (icon tile + description + primary action), then
 *  stacked sections of labelled rows. Use for one machine / integration /
 *  messenger / model config opened from a List. */
const story: Story = {
  title: "Detail",
  group: "Templates",
  blurb: "single object · header + action bar + stacked field sections",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        One object's detail view: page header (title + status), an action bar
        (icon tile + description, with an optional primary action), then stacked
        sections of labelled field rows. Reach for it when opening a single record
        from a List — a machine, integration, messenger, or model config.
      </p>
      <Wire ratio="console page">
        <WireBox label="page header · title + status" h={40} />
        <WireRow gap={10} align="center">
          <WireBox label="icon" h={48} w={48} tone="muted" />
          <WireBox label="description" h={48} grow={1} />
          <WireBox label="primary" h={38} w={110} tone="accent" />
        </WireRow>
        <WireBox label="section header" h={28} tone="muted" />
        <WireRepeat count={4} h={32} label="field row" />
        <WireBox label="section header" h={28} tone="muted" />
        <WireRepeat count={3} h={32} label="field row" />
      </Wire>
      <PreviewLink id="detail" />
    </div>
  ),
};

export default story;
