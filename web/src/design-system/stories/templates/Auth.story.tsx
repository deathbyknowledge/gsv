import type { Story } from "../../story";
import { Wire, WireRow, WireCol, WireBox, PreviewLink } from "../../wireframe";

/** AUTH archetype — the pre-shell surface: a full-bleed animated void backdrop
 *  (GSV-forming galaxy / stars) with a right-aligned panel slot carrying the
 *  login form or setup wizard. Use for sign-in, registration, and onboarding. */
const story: Story = {
  title: "Auth",
  group: "Templates",
  blurb: "pre-shell surface · full-bleed backdrop + right-aligned panel slot",
  render: () => (
    <div class="ds-tpl-stack">
      <p class="ds-tpl-blurb">
        The pre-shell surface: a full-bleed animated void backdrop (GSV-forming
        galaxy or flickering stars) with a right-aligned panel slot carrying the
        login form or setup wizard. Reach for it for sign-in, registration, and
        onboarding — anything before the desktop shell mounts.
      </p>
      <Wire ratio="full viewport">
        <WireRow gap={10} align="stretch">
          <WireCol grow={2} gap={8}>
            <WireBox label="animated backdrop · galaxy / stars" h={180} tone="dashed" />
          </WireCol>
          <WireCol w={170} gap={8}>
            <WireBox label="panel slot" h={40} tone="accent" />
            <WireBox label="username" h={34} />
            <WireBox label="password" h={34} />
            <WireBox label="enter" h={38} tone="accent" />
          </WireCol>
        </WireRow>
      </Wire>
      <PreviewLink id="auth" />
    </div>
  ),
};

export default story;
