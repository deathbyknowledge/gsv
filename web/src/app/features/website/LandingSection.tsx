import { useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/TextInput";

const DEMO_VIDEO = "https://gsv.space/demovid_edited.mp4";
const DEMO_POSTER = "https://gsv.space/demovid-poster.jpg";

/* Titles carry the page; the descriptions are held back until asked for. */
const VALUE_PROPS = [
  {
    title: "one mind, every device",
    body: "Your laptop, phone, and servers act as one computer, one context, one memory, and it stays awake even when they’re all asleep.",
  },
  {
    title: "your account, your keys",
    body: "Runs in your own Cloudflare account — your keys, your data, never routed through us. No open ports, no VPN, nothing exposed.",
  },
  {
    title: "open from the ground up",
    body: "MIT-licensed. Read every line yourself, run your own, fork it. Don’t take our word for it.",
  },
];

function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 2 && trimmed.includes("@") && !trimmed.endsWith("@");
}

/** ValueProp — title only until it is hovered or focused, then the description
 *  opens beneath it.
 *
 *  Hover and keyboard focus are handled in CSS (:hover / :focus-within) rather
 *  than in state: focus fires before click, so a JS toggle would be opened by
 *  the focus and immediately shut again by the click of the same tap. Click
 *  only pins the card open, which is what a touch user needs. */
function ValueProp({ title, body }: { title: string; body: string }) {
  const [pinned, setPinned] = useState(false);

  return (
    <li class={`gsv-site-prop${pinned ? " is-pinned" : ""}`}>
      <button
        type="button"
        class="gsv-site-prop-toggle"
        aria-expanded={pinned}
        onClick={() => setPinned((v) => !v)}
      >
        <span class="gsv-site-prop-title gsv-section">{title}</span>
        <span class="gsv-site-prop-cue" aria-hidden="true" />
      </button>
      <p class="gsv-site-prop-body gsv-prose">{body}</p>
    </li>
  );
}

/** LandingSection — where the narrative resolves into an ordinary page: what
 *  the product is, a way in, and the demo.
 *
 *  The sign-up form is a visual mock. Nothing is sent and nothing is stored;
 *  submitting only swaps in the confirmation state. */
export function LandingSection() {
  const [email, setEmail] = useState("");
  const [joined, setJoined] = useState(false);
  const [touched, setTouched] = useState(false);

  const invalid = touched && email.trim().length > 0 && !isPlausibleEmail(email);

  function submit(event: Event) {
    event.preventDefault();
    setTouched(true);
    if (!isPlausibleEmail(email)) return;
    setJoined(true);
  }

  return (
    <section class="gsv-site-landing" id="gsv-site-landing" aria-label="About GSV">
      <div class="gsv-site-landing-inner">
        <header class="gsv-site-hero">
          <p class="gsv-site-eyebrow gsv-sublabel">general systems vehicle</p>
          <h1 class="gsv-site-hero-title">a mind for your machines</h1>
        </header>

        <ul class="gsv-site-props">
          {VALUE_PROPS.map((prop) => (
            <ValueProp key={prop.title} title={prop.title} body={prop.body} />
          ))}
        </ul>

        <div class="gsv-site-cta">
          <h2 class="gsv-site-cta-title">get there first</h2>
          {joined ? (
            <p class="gsv-site-cta-done gsv-prose" role="status">
              You’re on the list. We’ll be in touch when there’s a seat.
            </p>
          ) : (
            <form class="gsv-site-cta-form" onSubmit={submit} noValidate>
              <TextInput
                label="Email"
                type="text"
                size="large"
                requirement="required"
                placeholder="your@email.com"
                value={email}
                status={invalid ? "error" : "none"}
                message={invalid ? "Enter a valid email address." : ""}
                inputProps={{ autoComplete: "email", inputMode: "email" }}
                onChange={(value) => {
                  setEmail(value);
                  setTouched(true);
                }}
              />
              <Button variant="primary" label="Early trial access" type="submit" />
            </form>
          )}
          <p class="gsv-site-cta-note gsv-sublabel">Mock form · nothing is sent</p>
        </div>

        <div class="gsv-site-demo">
          <h2 class="gsv-site-demo-title gsv-section">see it in action</h2>
          <video
            class="gsv-site-demo-video"
            src={DEMO_VIDEO}
            poster={DEMO_POSTER}
            controls
            preload="none"
            playsInline
            width={1280}
            height={720}
          />
        </div>
      </div>
    </section>
  );
}
