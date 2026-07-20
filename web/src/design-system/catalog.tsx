import { useEffect, useRef, useState } from "preact/hooks";
import { STORY_GROUP_ORDER, type Story, type StoryGroup } from "./story";
import { Search } from "../app/components/ui/Search";

// ── Story registry ────────────────────────────────────────────────────────
// Each ported component contributes one story file. Add the import + registry
// entry here when a new component lands. Kept as an explicit list (rather than
// glob) so review diffs show exactly what entered the catalog.
import foundationsTokens from "./stories/Tokens.story";
import typography from "./stories/Typography.story";
import icons from "./stories/Icons.story";
import gsvMark from "./stories/GsvMark.story";
import scrollbar from "./stories/Scrollbar.story";
import button from "./stories/Button.story";
import textInput from "./stories/TextInput.story";
import search from "./stories/Search.story";
import textArea from "./stories/TextArea.story";
import select from "./stories/Select.story";
import twoLevelSelect from "./stories/TwoLevelSelect.story";
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
import externalApplicationTile from "./stories/ExternalApplicationTile.story";
import surface from "./stories/Surface.story";
import iconButton from "./stories/IconButton.story";
import lineGlyphs from "./stories/LineGlyphs.story";
import sectionHeader from "./stories/SectionHeader.story";
import addAction from "./stories/AddAction.story";
import iconMenu from "./stories/IconMenu.story";
import desktopHint from "./stories/DesktopHint.story";
import listTemplate from "./stories/templates/List.story";
import cardListTemplate from "./stories/templates/CardList.story";
import detailTemplate from "./stories/templates/Detail.story";
import editorTemplate from "./stories/templates/Editor.story";
import dashboardTemplate from "./stories/templates/Dashboard.story";
import filesTemplate from "./stories/templates/Files.story";
import libraryTemplate from "./stories/templates/Library.story";
import authTemplate from "./stories/templates/Auth.story";
import assetImages from "./stories/assets/Images.story";
import assetDoticons from "./stories/assets/Doticons.story";
import assetAnimations from "./stories/assets/Animations.story";
import consoleHeader from "./stories/ConsoleHeader.story";
import breadcrumbs from "./stories/Breadcrumbs.story";
import statusBar from "./stories/StatusBar.story";
import messageInput from "./stories/MessageInput.story";
import systemMessage from "./stories/SystemMessage.story";
import messageMeta from "./stories/MessageMeta.story";
import chatMessageTypography from "./stories/ChatMessageTypography.story";
import chatDockHeader from "./stories/ChatDockHeader.story";
import chatSwipeRow from "./stories/ChatSwipeRow.story";
import tabs from "./stories/Tabs.story";
import popoverMenu from "./stories/PopoverMenu.story";
import confirmModal from "./stories/ConfirmModal.story";
import agentCard from "./stories/AgentCard.story";
import crewTile from "./stories/CrewTile.story";
import agentEditor from "./stories/AgentEditor.story";
import agentToolsPanel from "./stories/AgentToolsPanel.story";
import link from "./stories/Link.story";

const STORIES: Story[] = [
  // Foundations
  foundationsTokens,
  typography,
  icons,
  gsvMark,
  scrollbar,
  // Forms
  button,
  textInput,
  search,
  textArea,
  select,
  twoLevelSelect,
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
  externalApplicationTile,
  surface,
  agentImage,
  avatar,
  // Chrome
  iconButton,
  lineGlyphs,
  sectionHeader,
  addAction,
  iconMenu,
  desktopHint,
  consoleHeader,
  breadcrumbs,
  statusBar,
  messageInput,
  systemMessage,
  messageMeta,
  chatMessageTypography,
  chatDockHeader,
  chatSwipeRow,
  tabs,
  link,
  // Composite
  popoverMenu,
  confirmModal,
  agentCard,
  crewTile,
  agentEditor,
  agentToolsPanel,
  // Templates — generic page archetypes: wireframe + live preview of the real
  // component at /design/preview/<id> (see previews.tsx)
  listTemplate,
  cardListTemplate,
  detailTemplate,
  editorTemplate,
  dashboardTemplate,
  filesTemplate,
  libraryTemplate,
  authTemplate,
  // Assets — usage-audited inventory of images, icon sets, and animations
  assetImages,
  assetDoticons,
  assetAnimations,
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

type Tab = "components" | "templates" | "assets";

const TABS: { id: Tab; label: string }[] = [
  { id: "components", label: "Components" },
  { id: "templates", label: "Templates" },
  { id: "assets", label: "Assets" },
];

export function Catalog() {
  const [tab, setTab] = useState<Tab>("components");
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const noun = tab;

  // Case-insensitive match across the searchable fields of a story.
  const q = query.trim().toLowerCase();
  const matchesQuery = (s: Story) =>
    q === "" ||
    s.title.toLowerCase().includes(q) ||
    s.group.toLowerCase().includes(q) ||
    (s.blurb?.toLowerCase().includes(q) ?? false);

  // Templates and Assets live in their own tabs; everything else is the
  // Components tab. Search narrows within the active tab.
  const tabStories = STORIES.filter((s) =>
    tab === "templates"
      ? s.group === "Templates"
      : tab === "assets"
        ? s.group === "Assets"
        : s.group !== "Templates" && s.group !== "Assets",
  ).filter(matchesQuery);

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
    // `.ds-root` is its own scroll container (inside the fixed-height #app),
    // so resetting the window scroll position would be a no-op.
    rootRef.current?.scrollTo(0, 0);
  };

  return (
    <div class="ds-root" ref={rootRef}>
      <header class="ds-topbar">
        <h1>GSV Design System</h1>
        <span class="ds-sub">component catalog</span>
        <div class="ds-search">
          <Search
            value={query}
            placeholder={`Search ${noun}…`}
            size="small"
            block
            onChange={setQuery}
          />
        </div>
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
          {tabStories.length === 0 ? (
            <div class="ds-empty">
              No {noun} match “{query.trim()}”.
            </div>
          ) : (
            groups.map((group) => (
              <div key={group}>
                <h2 class="ds-group-head">{group}</h2>
                {byGroup.get(group)!.map((story) => (
                  <StoryCard key={story.title} story={story} />
                ))}
              </div>
            ))
          )}
        </main>
      </div>
    </div>
  );
}
