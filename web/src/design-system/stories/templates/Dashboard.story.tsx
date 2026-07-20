import type { Story } from "../../story";
import { Wire, WireRow, WireCol, WireBox, WireRepeat, PreviewLink } from "../../wireframe";

/** DASHBOARD archetype — the console overview: a two-column mosaic of panels
 *  summarising every object category (The Ship, Crew, Models & Tasks, Fleet,
 *  Applications). Each panel is an action header over a few preview rows that
 *  deep-link into the corresponding List. Use as a system landing / overview. */
const story: Story = {
  title: "Dashboard",
  group: "Templates",
  blurb: "system overview · two-column panel mosaic · category summaries",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        The console overview: a two-column mosaic of panels summarising every
        object category (The Ship, Crew, Models &amp; Tasks, Fleet, Applications).
        Each panel is an action header over a few preview rows that deep-link into
        the matching List. Reach for it as a system landing surface.
      </p>
      <Wire ratio="console page">
        <WireRow gap={10} align="stretch">
          <WireCol grow={1} gap={8}>
            <WireBox label="the ship · planet scan" h={92} tone="muted" />
            <WireBox label="crew · header" h={24} tone="muted" />
            <WireRow gap={8}>
              <WireBox label="crew tile" h={64} tone="muted" />
              <WireBox label="crew tile" h={64} tone="muted" />
              <WireBox label="+ add" h={64} tone="dashed" />
            </WireRow>
            <WireBox label="models & tasks · header" h={24} tone="muted" />
            <WireRepeat count={3} h={30} label="row" />
          </WireCol>
          <WireCol grow={1} gap={8}>
            <WireBox label="fleet · header" h={24} tone="muted" />
            <WireRepeat count={4} h={30} label="target / integration row" />
            <WireBox label="applications · header" h={24} tone="muted" />
            <WireRepeat count={2} h={30} label="application row" />
          </WireCol>
        </WireRow>
      </Wire>
      <PreviewLink id="dashboard" />
    </div>
  ),
};

export default story;
