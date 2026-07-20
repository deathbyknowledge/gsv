import type { Story } from "../../story";
import { Wire, WireRow, WireCol, WireBox, WireRepeat, PreviewLink } from "../../wireframe";

/** LIST archetype — a full-width page header over a two-column body: an ACTION
 *  column (search / filters / connect) beside a LIST column of status rows. Use
 *  for object inventories where each row is a small labelled record with a
 *  status: Machines, Integrations, Tasks. */
const story: Story = {
  title: "List",
  group: "Templates",
  blurb: "object inventory · header + action column + status rows",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        A page header (title + count) over a body split into an ACTION column
        (search, optional filters, connect-new) and a LIST column of status rows —
        or the shared empty state. Reach for it when each object is a compact
        labelled record with a status: Machines, Integrations, Tasks.
      </p>
      <Wire ratio="console page">
        <WireBox label="page header · title + count" h={40} />
        <WireRow gap={10}>
          <WireCol w={200} gap={8}>
            <WireBox label="search" h={34} />
            <WireBox label="filters" h={34} tone="muted" />
            <WireBox label="connect new" h={38} tone="accent" />
          </WireCol>
          <WireCol grow={1} gap={6}>
            <WireRepeat count={5} h={34} label="status row" />
          </WireCol>
        </WireRow>
      </Wire>
      <PreviewLink id="list" />
    </div>
  ),
};

export default story;
