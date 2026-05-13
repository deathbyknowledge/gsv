import { openApp } from "@gsv/package/host";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ATTENTION_ITEMS, GROUPS, SECTIONS, findSection, sectionExists } from "./navigation";
import type { GsvGroup, GsvSection, GsvSectionId, Tone } from "./types";

export function App() {
  const [activeSectionId, setActiveSectionId] = useState<GsvSectionId>(readSectionFromLocation);
  const activeSection = useMemo(() => findSection(activeSectionId), [activeSectionId]);
  const activeGroup = GROUPS.find((group) => group.id === activeSection.groupId) ?? GROUPS[0];

  useEffect(() => {
    const onPopState = () => setActiveSectionId(readSectionFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(sectionId: GsvSectionId): void {
    const url = new URL(window.location.href);
    url.searchParams.set("section", sectionId);
    window.history.pushState({}, "", url);
    setActiveSectionId(sectionId);
  }

  function openHandoff(target: string, route?: string): void {
    openApp({
      target,
      payload: route ? { route } : undefined,
    });
  }

  return (
    <div class="gsv-app">
      <aside class="gsv-sidebar" aria-label="GSV sections">
        <header class="gsv-brand">
          <div>
            <span class="gsv-kicker">System</span>
            <h1>GSV</h1>
          </div>
          <span class="gsv-status-dot" aria-label="Console ready"></span>
        </header>
        <DesktopNav activeSectionId={activeSectionId} onNavigate={navigate} />
      </aside>

      <section class="gsv-workspace">
        <TopBar section={activeSection} group={activeGroup} />
        <main class="gsv-main">
          {activeSection.id === "overview" ? (
            <Overview onNavigate={navigate} onOpenHandoff={openHandoff} />
          ) : (
            <SectionWorkspace section={activeSection} onOpenHandoff={openHandoff} />
          )}
        </main>
      </section>

      <MobileNav activeSection={activeSection} onNavigate={navigate} />
    </div>
  );
}

function DesktopNav({
  activeSectionId,
  onNavigate,
}: {
  activeSectionId: GsvSectionId;
  onNavigate: (sectionId: GsvSectionId) => void;
}) {
  return (
    <nav class="gsv-nav">
      {GROUPS.map((group) => (
        <section class="gsv-nav-group" key={group.id}>
          <h2>{group.label}</h2>
          <div class="gsv-nav-list">
            {group.sections.map((sectionId) => {
              const section = findSection(sectionId);
              return (
                <button
                  key={section.id}
                  class={`gsv-nav-item${activeSectionId === section.id ? " is-active" : ""}`}
                  type="button"
                  onClick={() => onNavigate(section.id)}
                >
                  <StatusMark tone={section.tone} />
                  <span>{section.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </nav>
  );
}

function TopBar({ section, group }: { section: GsvSection; group: GsvGroup }) {
  return (
    <header class="gsv-topbar">
      <div>
        <span class="gsv-kicker">{group.label}</span>
        <h2>{section.title}</h2>
      </div>
      <div class="gsv-topbar-state">
        <StatusMark tone={section.tone} />
        <span>{section.statusLabel}</span>
      </div>
    </header>
  );
}

function Overview({
  onNavigate,
  onOpenHandoff,
}: {
  onNavigate: (sectionId: GsvSectionId) => void;
  onOpenHandoff: (target: string, route?: string) => void;
}) {
  const overview = findSection("overview");

  return (
    <section class="gsv-overview">
      <div class="gsv-section-intro">
        <span class="gsv-kicker">Attention inbox</span>
        <h3>{overview.summary}</h3>
      </div>

      <div class="gsv-attention-list" aria-label="Attention destinations">
        {ATTENTION_ITEMS.map((item) => {
          const section = findSection(item.sectionId);
          return (
            <button
              class="gsv-attention-row"
              key={item.label}
              type="button"
              onClick={() => onNavigate(item.sectionId)}
            >
              <StatusMark tone={item.tone} />
              <span class="gsv-row-copy">
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </span>
              <span class="gsv-row-target">{section.label}</span>
            </button>
          );
        })}
      </div>

      <section class="gsv-handoff-panel" aria-label="Current compatibility surfaces">
        <header>
          <span class="gsv-kicker">Current surfaces</span>
          <h3>Compatibility handoffs</h3>
        </header>
        <div class="gsv-handoff-list">
          {overview.handoffs.map((handoff) => (
            <button
              class="gsv-handoff-row"
              key={handoff.label}
              type="button"
              onClick={() => onOpenHandoff(handoff.target, handoff.route)}
            >
              <span>
                <strong>{handoff.label}</strong>
                <span>{handoff.description}</span>
              </span>
              <span class="gsv-arrow" aria-hidden="true">&gt;</span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function SectionWorkspace({
  section,
  onOpenHandoff,
}: {
  section: GsvSection;
  onOpenHandoff: (target: string, route?: string) => void;
}) {
  return (
    <section class="gsv-section-workspace">
      <aside class="gsv-local-list" aria-label={`${section.label} local navigation`}>
        <div class="gsv-section-intro">
          <span class="gsv-kicker">{section.label}</span>
          <h3>{section.summary}</h3>
        </div>
        <div class="gsv-object-list">
          {section.localItems.map((item) => (
            <button class="gsv-object-row" key={item.label} type="button">
              <StatusMark tone={item.tone ?? "neutral"} />
              <span class="gsv-row-copy">
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </span>
              <span class="gsv-row-meta">{item.meta}</span>
            </button>
          ))}
        </div>
      </aside>

      <section class="gsv-detail-pane" aria-label={`${section.label} detail`}>
        <header>
          <span class="gsv-kicker">{section.statusLabel}</span>
          <h3>{section.title}</h3>
          <p>{section.summary}</p>
        </header>
        <div class="gsv-handoff-list">
          {section.handoffs.map((handoff) => (
            <button
              class="gsv-handoff-row"
              key={handoff.label}
              type="button"
              onClick={() => onOpenHandoff(handoff.target, handoff.route)}
            >
              <span>
                <strong>{handoff.label}</strong>
                <span>{handoff.description}</span>
              </span>
              <span class="gsv-arrow" aria-hidden="true">&gt;</span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function MobileNav({
  activeSection,
  onNavigate,
}: {
  activeSection: GsvSection;
  onNavigate: (sectionId: GsvSectionId) => void;
}) {
  return (
    <nav class="gsv-mobile-nav" aria-label="GSV groups">
      {GROUPS.map((group) => {
        const targetSection = group.sections[0];
        const isActive = activeSection.groupId === group.id;
        return (
          <button
            key={group.id}
            class={`gsv-mobile-nav-item${isActive ? " is-active" : ""}`}
            type="button"
            onClick={() => onNavigate(targetSection)}
          >
            <StatusMark tone={isActive ? activeSection.tone : "neutral"} />
            <span>{group.shortLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}

function StatusMark({ tone }: { tone: Tone }) {
  return <span class={`gsv-mark is-${tone}`} aria-hidden="true"></span>;
}

function readSectionFromLocation(): GsvSectionId {
  const value = new URL(window.location.href).searchParams.get("section") ?? "";
  return sectionExists(value) ? value : "overview";
}
