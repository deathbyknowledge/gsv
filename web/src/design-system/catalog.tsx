import { useEffect, useState } from "preact/hooks";
import { STORY_GROUP_ORDER, type Story, type StoryGroup } from "./story";

// ── Story registry ────────────────────────────────────────────────────────
// Each ported component contributes one story file. Add the import + registry
// entry here when a new component lands. Kept as an explicit list (rather than
// glob) so review diffs show exactly what entered the catalog.
import foundationsTokens from "./stories/Tokens.story";
import typography from "./stories/Typography.story";
import icons from "./stories/Icons.story";
import scrollbar from "./stories/Scrollbar.story";
import button from "./stories/Button.story";
import textInput from "./stories/TextInput.story";
import search from "./stories/Search.story";
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
import infoTip from "./stories/InfoTip.story";
import alert from "./stories/Alert.story";
import listRow from "./stories/ListRow.story";
import asciiPlanet from "./stories/AsciiPlanet.story";
import asciiGalaxyScan from "./stories/AsciiGalaxyScan.story";
import agentImage from "./stories/AgentImage.story";
import avatar from "./stories/Avatar.story";
import tile from "./stories/Tile.story";
import objectCard from "./stories/ObjectCard.story";
import surface from "./stories/Surface.story";
import iconButton from "./stories/IconButton.story";
import sectionHeader from "./stories/SectionHeader.story";
import addAction from "./stories/AddAction.story";
import settingsDashboard from "./stories/SettingsDashboard.story";
import crewPage from "./stories/CrewPage.story";
import agentDetail from "./stories/AgentDetail.story";
import settingsList from "./stories/SettingsList.story";
import objectDetail from "./stories/ObjectDetail.story";
import filesRedesign from "./stories/FilesRedesign.story";
import iconMenu from "./stories/IconMenu.story";
import consoleHeader from "./stories/ConsoleHeader.story";
import breadcrumbs from "./stories/Breadcrumbs.story";
import statusBar from "./stories/StatusBar.story";
import messageInput from "./stories/MessageInput.story";
import systemMessage from "./stories/SystemMessage.story";
import tabs from "./stories/Tabs.story";
import confirmModal from "./stories/ConfirmModal.story";
import agentCard from "./stories/AgentCard.story";
import crewTile from "./stories/CrewTile.story";
import agentEditor from "./stories/AgentEditor.story";
import authLayout from "./stories/AuthLayout.story";
import link from "./stories/Link.story";

const STORIES: Story[] = [
  // Foundations
  foundationsTokens,
  typography,
  icons,
  scrollbar,
  // Forms
  button,
  textInput,
  search,
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
  infoTip,
  alert,
  // Data Display
  listRow,
  asciiPlanet,
  asciiGalaxyScan,
  tile,
  objectCard,
  surface,
  agentImage,
  avatar,
  // Chrome
  iconButton,
  sectionHeader,
  addAction,
  iconMenu,
  consoleHeader,
  breadcrumbs,
  statusBar,
  messageInput,
  systemMessage,
  tabs,
  authLayout,
  link,
  // Composite
  confirmModal,
  agentCard,
  crewTile,
  agentEditor,
  // Templates
  settingsDashboard,
  crewPage,
  agentDetail,
  settingsList,
  objectDetail,
  filesRedesign,
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

type Tab = "components" | "templates";

const TABS: { id: Tab; label: string }[] = [
  { id: "components", label: "Components" },
  { id: "templates", label: "Templates" },
];

export function Catalog() {
  const [tab, setTab] = useState<Tab>("components");

  // Templates live in their own tab; everything else is the Components tab.
  const tabStories = STORIES.filter((s) =>
    tab === "templates" ? s.group === "Templates" : s.group !== "Templates",
  );

  const byGroup = new Map<StoryGroup, Story[]>();
  for (const story of tabStories) {
    const list = byGroup.get(story.group) ?? [];
    list.push(story);
    byGroup.set(story.group, list);
  }
  const groups = STORY_GROUP_ORDER.filter((g) => byGroup.has(g));
  const active = useScrollSpy(tabStories.map((s) => slugify(s.title)));

  const selectTab = (id: Tab) => {
    setTab(id);
    window.scrollTo(0, 0);
  };

  return (
    <div class="ds-root">
      <header class="ds-topbar">
        <h1>GSV Design System</h1>
        <span class="ds-sub">migration preview · web/ port</span>
        <div class="ds-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              class={`ds-tab${tab === t.id ? " is-active" : ""}`}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
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
