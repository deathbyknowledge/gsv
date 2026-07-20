import type { Story } from "../../story";
import { Wire, WireRow, WireCol, WireBox, WireRepeat } from "../../wireframe";

/** LIBRARY archetype — the knowledge-base surface: a collection bar (title +
 *  meta + actions) over a workspace split into an ACTION column (search + new
 *  page) and a BROWSER column (breadcrumbs + page list / search results). No
 *  live preview: the real surface is service-coupled (gateway workspace hook). */
const story: Story = {
  title: "Library",
  group: "Templates",
  blurb: "knowledge base · collection bar + search column + page browser",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        The knowledge-base surface: a collection bar (title + meta + actions) over
        a workspace split into an ACTION column (search + new page) and a BROWSER
        column (breadcrumbs + page list, or search results). Reach for it to browse
        and edit structured collections of pages.
      </p>
      <Wire ratio="console page">
        <WireRow gap={10} align="center">
          <WireBox label="collection · title + meta" h={40} grow={1} />
          <WireBox label="action" h={34} w={90} tone="muted" />
          <WireBox label="action" h={34} w={90} tone="accent" />
        </WireRow>
        <WireRow gap={10}>
          <WireCol w={200} gap={8}>
            <WireBox label="search pages" h={34} />
            <WireBox label="new page" h={38} tone="accent" />
          </WireCol>
          <WireCol grow={1} gap={6}>
            <WireBox label="breadcrumbs" h={26} tone="muted" />
            <WireRepeat count={5} h={32} label="page row" />
          </WireCol>
        </WireRow>
      </Wire>
      <p class="ds-tpl-note">
        No live preview — the real Library surface is service-coupled: it renders
        through the gateway-backed useLibraryWorkspace hook (useGateway + useQuery /
        useMutation) and short-circuits to a connection/loading gate without a live
        client, so it can't be driven by props alone.
      </p>
    </div>
  ),
};

export default story;
