import { openApp } from "@gsv/package/host";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "./backend-contract";
import { DevicesSection } from "./features/devices/DevicesSection";
import { IntegrationsSection } from "./features/integrations/IntegrationsSection";
import { OverviewSection } from "./features/overview/OverviewSection";
import { PackagesSection } from "./features/packages/PackagesSection";
import { RuntimeSection } from "./features/runtime/RuntimeSection";
import { AdministrationSection } from "./features/settings/AdministrationSection";
import { SourcesSection } from "./features/sources/SourcesSection";
import { GROUPS, findSection } from "./navigation/sections";
import {
  pushPackagesLocation,
  pushSectionLocation,
  pushSourcesLocation,
  readSectionFromLocation,
  type PackagesRouteView,
} from "./navigation/route-state";
import type { GsvGroup, GsvHandoff, GsvSection, GsvSectionId, Tone } from "./navigation/types";

export function App({ backend }: { backend: GsvBackend }) {
  const [activeSectionId, setActiveSectionId] = useState<GsvSectionId>(readSectionFromLocation);
  const activeSection = useMemo(() => findSection(activeSectionId), [activeSectionId]);
  const activeGroup = GROUPS.find((group) => group.id === activeSection.groupId) ?? GROUPS[0];

  useEffect(() => {
    const onPopState = () => setActiveSectionId(readSectionFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(sectionId: GsvSectionId): void {
    if (sectionId === "sources") {
      pushSourcesLocation({ repo: null });
      setActiveSectionId(sectionId);
      return;
    }
    pushSectionLocation(sectionId);
    setActiveSectionId(sectionId);
  }

  function openHandoff(target: string, route?: string): void {
    openApp({
      target,
      payload: route ? { route } : undefined,
    });
  }

  function openSources(repo: string, ref?: string, path?: string): void {
    pushSourcesLocation({ repo, ref, path });
    setActiveSectionId("sources");
  }

  function openPackage(packageId: string, view: PackagesRouteView = "inventory"): void {
    pushPackagesLocation({ packageId, view });
    setActiveSectionId("packages");
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
        <MobileSectionTabs group={activeGroup} activeSectionId={activeSectionId} onNavigate={navigate} />
        <main class="gsv-main">
          {activeSection.id === "overview" ? (
            <OverviewSection backend={backend} onNavigate={navigate} onOpenPackage={openPackage} />
          ) : activeSection.id === "runtime" ? (
            <RuntimeSection backend={backend} />
          ) : activeSection.id === "devices" ? (
            <DevicesSection backend={backend} />
          ) : activeSection.id === "integrations" ? (
            <IntegrationsSection backend={backend} />
          ) : activeSection.id === "packages" ? (
            <PackagesSection backend={backend} onOpenSources={openSources} />
          ) : activeSection.id === "sources" ? (
            <SourcesSection backend={backend} onOpenPackage={openPackage} />
          ) : activeSection.id === "access" ? (
            <AdministrationSection backend={backend} mode="access" />
          ) : activeSection.id === "settings" ? (
            <AdministrationSection backend={backend} mode="settings" />
          ) : (
            <SectionWorkspace section={activeSection} onNavigate={navigate} onOpenHandoff={openHandoff} />
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

function MobileSectionTabs({
  group,
  activeSectionId,
  onNavigate,
}: {
  group: GsvGroup;
  activeSectionId: GsvSectionId;
  onNavigate: (sectionId: GsvSectionId) => void;
}) {
  if (group.sections.length < 2) {
    return null;
  }

  return (
    <nav class="gsv-mobile-section-nav" aria-label={`${group.label} sections`}>
      {group.sections.map((sectionId) => {
        const section = findSection(sectionId);
        return (
          <button
            key={section.id}
            type="button"
            class={activeSectionId === section.id ? "is-active" : ""}
            onClick={() => onNavigate(section.id)}
          >
            {section.shortLabel}
          </button>
        );
      })}
    </nav>
  );
}

function SectionWorkspace({
  section,
  onNavigate,
  onOpenHandoff,
}: {
  section: GsvSection;
  onNavigate: (sectionId: GsvSectionId) => void;
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
              onClick={() => openHandoffTarget(handoff, onNavigate, onOpenHandoff)}
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

function openHandoffTarget(
  handoff: GsvHandoff,
  onNavigate: (sectionId: GsvSectionId) => void,
  onOpenHandoff: (target: string, route?: string) => void,
): void {
  if (handoff.sectionId) {
    onNavigate(handoff.sectionId);
    return;
  }
  if (handoff.target) {
    onOpenHandoff(handoff.target, handoff.route);
  }
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
