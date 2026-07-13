import type { Story } from "../../story";
import { Wire, WireRow, WireBox, WireGrid, PreviewLink } from "../../wireframe";

/** CARD LIST archetype — a full-width page header, a horizontal action bar on
 *  top (search / filters / connect), then a responsive full-width card grid (or
 *  the shared empty state). Use when each object needs a richer visual cell than
 *  a row: Crew, Messengers, Applications. */
const story: Story = {
  title: "Card list",
  group: "Templates",
  blurb: "object grid · header + action bar + responsive card grid",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        A page header (title + count), a horizontal action bar (search, optional
        filters, connect-new), then a responsive card grid — or the shared empty
        state. Reach for it when each object deserves a richer visual cell than a
        list row: Crew, Messengers.
      </p>
      <Wire ratio="console page">
        <WireBox label="page header · title + count" h={40} />
        <WireRow gap={10}>
          <WireBox label="search" h={34} grow={2} />
          <WireBox label="filters" h={34} tone="muted" />
          <WireBox label="connect new" h={34} w={150} tone="accent" />
        </WireRow>
        <WireGrid count={4} h={104} min={130} />
      </Wire>
      <PreviewLink id="card-list" />
    </div>
  ),
};

export default story;
