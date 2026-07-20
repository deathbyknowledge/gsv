import type { Story } from "../../story";
import { Wire, WireRow, WireBox, WireRepeat } from "../../wireframe";

/** FILES archetype — the file-browser surface: a machine Select + refresh top
 *  row, an open-file tab strip, breadcrumbs, a search/create toolbar, then the
 *  directory listing (or an inline editor when a file is open). No live preview:
 *  the real surface is service-coupled (gateway queries + mutations). */
const story: Story = {
  title: "Files",
  group: "Templates",
  blurb: "file browser · machine select + tabs + breadcrumbs + listing / editor",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        The file-browser surface: a machine Select + refresh top row, an open-file
        tab strip, breadcrumbs, a search/create toolbar, then the directory
        listing — swapped for an inline editor when a file is open. Reach for it to
        browse and edit files across the local instance and connected machines.
      </p>
      <Wire ratio="console page">
        <WireRow gap={10} align="center">
          <WireBox label="machine select" h={34} w={200} tone="muted" />
          <WireBox label="" h={34} tone="dashed" />
          <WireBox label="refresh" h={34} w={100} tone="muted" />
        </WireRow>
        <WireRow gap={6}>
          <WireBox label="browser" h={28} tone="accent" />
          <WireBox label="readme.md" h={28} tone="muted" />
          <WireBox label="package.json" h={28} tone="dashed" />
        </WireRow>
        <WireBox label="breadcrumbs" h={26} tone="muted" />
        <WireRow gap={10}>
          <WireBox label="search files" h={34} grow={2} />
          <WireBox label="create new" h={34} w={120} tone="accent" />
        </WireRow>
        <WireRepeat count={4} h={34} label="dir / file row" />
      </Wire>
      <p class="ds-tpl-note">
        No live preview — the real Files surface is service-coupled: it renders
        through gateway-backed queries and mutations (useFilesTargets / useFilesPath
        / useFilesSearch / useFilesMutations) and needs a GatewayProvider +
        QueryClient, so it can't be driven by props alone.
      </p>
    </div>
  ),
};

export default story;
