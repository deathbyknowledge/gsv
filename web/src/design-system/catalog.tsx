import { useEffect, useState } from "preact/hooks";
import { STORY_GROUP_ORDER, type Story, type StoryGroup } from "./story";

// ── Story registry ────────────────────────────────────────────────────────
// Each ported component contributes one story file. Add the import + registry
// entry here when a new component lands. Kept as an explicit list (rather than
// glob) so review diffs show exactly what entered the catalog.
import foundationsTokens from "./stories/Tokens.story";
import icons from "./stories/Icons.story";
import button from "./stories/Button.story";
import textInput from "./stories/TextInput.story";
import textArea from "./stories/TextArea.story";
import select from "./stories/Select.story";
import segmented from "./stories/Segmented.story";
import checkbox from "./stories/Checkbox.story";
import radio from "./stories/Radio.story";
import toggle from "./stories/Toggle.story";
import slider from "./stories/Slider.story";
import counter from "./stories/Counter.story";
import stepper from "./stories/Stepper.story";
import statusDot from "./stories/StatusDot.story";
import tag from "./stories/Tag.story";
import progress from "./stories/Progress.story";
import spinner from "./stories/Spinner.story";
import tooltip from "./stories/Tooltip.story";
import listRow from "./stories/ListRow.story";
import agentImage from "./stories/AgentImage.story";
import avatar from "./stories/Avatar.story";
import iconButton from "./stories/IconButton.story";
import sectionHeader from "./stories/SectionHeader.story";
import addAction from "./stories/AddAction.story";

const STORIES: Story[] = [
  // Foundations
  foundationsTokens,
  icons,
  // Forms
  button,
  textInput,
  textArea,
  select,
  segmented,
  checkbox,
  radio,
  toggle,
  slider,
  counter,
  stepper,
  // Feedback
  statusDot,
  tag,
  progress,
  spinner,
  tooltip,
  // Data Display
  listRow,
  agentImage,
  avatar,
  // Chrome
  iconButton,
  sectionHeader,
  addAction,
];

// ───────────────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function StoryCard({ story }: { story: Story }) {
  return (
    <section class="ds-story" id={slugify(story.title)}>
      <header class="ds-story-head">
        <span class="ds-dot" />
        <h2>{story.title}</h2>
        {story.blurb ? <span class="ds-blurb">{story.blurb}</span> : null}
      </header>
      <div class="ds-story-body">{story.render()}</div>
    </section>
  );
}

/** Highlights the nav link whose section is currently in view. */
function useScrollSpy(slugs: string[]): string {
  const [active, setActive] = useState(slugs[0] ?? "");
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    for (const slug of slugs) {
      const el = document.getElementById(slug);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [slugs.join("|")]);
  return active;
}

export function Catalog() {
  const byGroup = new Map<StoryGroup, Story[]>();
  for (const story of STORIES) {
    const list = byGroup.get(story.group) ?? [];
    list.push(story);
    byGroup.set(story.group, list);
  }
  const groups = STORY_GROUP_ORDER.filter((g) => byGroup.has(g));
  const active = useScrollSpy(STORIES.map((s) => slugify(s.title)));

  return (
    <div class="ds-root">
      <header class="ds-topbar">
        <h1>GSV Design System</h1>
        <span class="ds-sub">migration preview · web/ port</span>
      </header>
      <div class="ds-layout">
        <nav class="ds-nav">
          {groups.map((group) => (
            <div class="ds-nav-group" key={group}>
              <div class="ds-nav-grouphead">{group}</div>
              {byGroup.get(group)!.map((story) => {
                const slug = slugify(story.title);
                return (
                  <a
                    key={slug}
                    class={`ds-nav-link${active === slug ? " is-active" : ""}`}
                    href={`#${slug}`}
                  >
                    {story.title}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <main class="ds-main">
          {groups.map((group) => (
            <div key={group}>
              <h2 class="ds-group-head">{group}</h2>
              {byGroup.get(group)!.map((story) => (
                <StoryCard key={story.title} story={story} />
              ))}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
