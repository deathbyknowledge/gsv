import type { Story } from "../../story";
import { Wire, WireRow, WireCol, WireBox, PreviewLink } from "../../wireframe";

/** EDITOR archetype — an authoring surface: page header (name + status), a
 *  folder tab strip (GENERAL / CONTEXT / TASKS), then a form column beside an
 *  identity/meta column, closing on a save/reset action row. Use for creating or
 *  managing a configurable object: Agent editor. */
const story: Story = {
  title: "Editor",
  group: "Templates",
  blurb: "authoring surface · header + folder tabs + form column + save row",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        An authoring surface: page header (name + status), a folder tab strip
        (GENERAL / CONTEXT / TASKS), then a form column beside an identity/meta
        column, closing on a save/reset action row. Reach for it when creating or
        managing a configurable object with grouped fields — the Agent editor.
      </p>
      <Wire ratio="console page">
        <WireBox label="page header · name + status" h={40} />
        <WireRow gap={6}>
          <WireBox label="general" h={30} tone="accent" />
          <WireBox label="context" h={30} tone="muted" />
          <WireBox label="tasks" h={30} tone="muted" />
        </WireRow>
        <WireRow gap={10}>
          <WireCol grow={2} gap={8}>
            <WireBox label="name field" h={40} />
            <WireBox label="role field" h={40} />
            <WireBox label="description field" h={56} />
            <WireBox label="overrides · model / reasoning / tools" h={72} tone="muted" />
          </WireCol>
          <WireCol w={150} gap={8}>
            <WireBox label="avatar + meta" h={80} tone="muted" />
          </WireCol>
        </WireRow>
        <WireRow gap={10}>
          <WireBox label="" h={36} tone="dashed" />
          <WireBox label="reset" h={36} w={90} tone="muted" />
          <WireBox label="save" h={36} w={90} tone="accent" />
        </WireRow>
      </Wire>
      <PreviewLink id="editor" />
    </div>
  ),
};

export default story;
