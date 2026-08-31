import {
  PLAIN_EDGES as ARCHITECTURE_EDGES,
  PLAIN_FLOWS as ARCHITECTURE_FLOWS,
  PLAIN_SUBSYSTEMS as ARCHITECTURE_SUBSYSTEMS,
  plainComponent as architectureComponent,
  plainSubsystem as architectureSubsystem,
  searchPlainLanguage as searchArchitecture,
} from "./plain-language.mjs";
import {
  ATLAS_CONCEPTS,
  ATLAS_DISTRICTS,
  ATLAS_LENSES,
  ATLAS_TOUR_NOTES,
  ATLAS_ZONES,
  atlasArchetype,
  atlasDetail,
  atlasDistrictForSystem,
  atlasScene,
} from "./atlas-meta.mjs";

const VIEWBOX = { width: 1200, height: 820, centerX: 600, centerY: 492 };
const WORLD_SCALE = 2.28;
const DEFAULT_CAMERA = { yaw: -0.58, pitch: 0.56, zoom: 1, targetX: 0, targetZ: 0 };

const EDGE_COLORS = {
  request: "#62f4ff",
  control: "#d8ff52",
  data: "#ee8bff",
  contract: "#7faaff",
  provision: "#ffb052",
};
const EDGE_WORDS = {
  request: "ASKS",
  control: "DIRECTS",
  data: "SAVES WITH",
  contract: "SHARES RULES",
  provision: "SETS UP",
};
const COMPONENT_FACADE_INDEX = 2;

const elements = {
  atlas: document.querySelector("#atlas"),
  lenses: document.querySelector("#lens-switcher"),
  helpButton: document.querySelector("#help-button"),
  helpDialog: document.querySelector("#help-dialog"),
  search: document.querySelector("#atlas-search-input"),
  searchResults: document.querySelector("#search-results"),
  systemIndex: document.querySelector("#system-index"),
  systems: document.querySelector("#system-list"),
  concept: document.querySelector("#concept-cycle"),
  lensCode: document.querySelector("#lens-code"),
  lensSummary: document.querySelector("#lens-summary"),
  world: document.querySelector("#world-svg"),
  scene: document.querySelector("#world-scene"),
  hover: document.querySelector("#hover-readout"),
  workspaceSwitcher: document.querySelector("#workspace-switcher"),
  mapKey: document.querySelector("#map-key"),
  mapKeyClose: document.querySelector("#map-key-close"),
  rotateLeft: document.querySelector("#rotate-left"),
  rotateRight: document.querySelector("#rotate-right"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomOut: document.querySelector("#zoom-out"),
  resetView: document.querySelector("#reset-view"),
  cameraReadout: document.querySelector("#camera-readout"),
  inspector: document.querySelector("#inspector"),
  flowSelect: document.querySelector("#flow-select"),
  flowStepNumber: document.querySelector("#flow-step-number"),
  flowStepSystem: document.querySelector("#flow-step-system"),
  flowStepTitle: document.querySelector("#flow-step-title"),
  flowStepDetail: document.querySelector("#flow-step-detail"),
  flowPrev: document.querySelector("#flow-prev"),
  flowNext: document.querySelector("#flow-next"),
  flowPlay: document.querySelector("#flow-play"),
  flowRail: document.querySelector("#flow-rail"),
  flowThesis: document.querySelector("#flow-thesis"),
  traceDeck: document.querySelector("#trace-deck"),
  toast: document.querySelector("#toast"),
};

const defaultFlow = ARCHITECTURE_FLOWS.find((flow) => flow.id === "human-turn") ?? ARCHITECTURE_FLOWS[0];
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const stackedWorkspace = window.matchMedia("(max-width: 1120px)");
const state = {
  selectedSubsystemId: "kernel",
  selectedComponentId: null,
  activePanel: window.matchMedia("(max-width: 1120px)").matches ? null : "systems",
  inspectorSection: "overview",
  lens: "runtime",
  activeFlowId: defaultFlow.id,
  activeFlowStep: 0,
  camera: { ...DEFAULT_CAMERA },
  cameraAnimation: 0,
  drag: null,
  ignoreNextClick: false,
  searchQuery: "",
  searchResults: [],
  playing: false,
  playTimer: 0,
  sourceBase: "https://github.com/deathbyknowledge/gsv",
  sha: "main",
  conceptIndex: 0,
  conceptTimer: 0,
  toastTimer: 0,
};

void initialize();

async function initialize() {
  const restoredSelection = restoreSelectionFromHash();
  if (restoredSelection) state.activePanel = "inspector";

  renderLensSwitcher();
  renderFlowOptions();
  renderWorkspace();
  renderAll();
  bindEvents();
  if (restoredSelection) revealWorkspace("inspector");
  updateConcept();
  syncConceptRotation();
  motionPreference.addEventListener("change", syncConceptRotation);

  try {
    const response = await fetch("/api/meta");
    if (!response.ok) throw new Error(`Revision request failed: ${response.status}`);
    const meta = await response.json();
    state.sha = meta.sha;
    state.sourceBase = meta.sourceBase;
    renderInspector();
  } catch {}
}

function bindEvents() {
  elements.workspaceSwitcher.addEventListener("click", (event) => {
    const button = event.target.closest("[data-workspace-panel]");
    if (!button) return;
    const panel = button.dataset.workspacePanel;
    const nextPanel = state.activePanel === panel ? null : panel;
    showWorkspace(nextPanel);
    if (nextPanel) revealWorkspace(nextPanel);
  });

  elements.systemIndex.addEventListener("click", (event) => {
    if (event.target.closest('[data-close-panel="systems"]')) closeWorkspace("systems");
  });

  elements.mapKeyClose.addEventListener("click", () => closeWorkspace("key"));

  elements.lenses.addEventListener("click", (event) => {
    const button = event.target.closest("[data-lens]");
    if (button) selectLens(button.dataset.lens);
  });

  elements.systems.addEventListener("click", (event) => {
    const button = event.target.closest("[data-system]");
    if (button) selectSubsystem(button.dataset.system, null, { focusInspector: true, reveal: true });
  });

  elements.search.addEventListener("input", () => {
    state.searchQuery = elements.search.value.trim();
    state.searchResults = searchAtlas(state.searchQuery);
    renderSearchResults();
    renderSystemList();
    renderWorld();
  });

  elements.searchResults.addEventListener("click", (event) => {
    const button = event.target.closest("[data-result-index]");
    if (!button) return;
    const result = state.searchResults[Number.parseInt(button.dataset.resultIndex, 10)];
    if (!result) return;
    clearSearch();
    selectSubsystem(result.subsystemId, result.componentId ?? null, { fly: true, focusInspector: true, reveal: true });
  });

  elements.inspector.addEventListener("click", (event) => {
    if (event.target.closest('[data-close-panel="inspector"]')) {
      closeWorkspace("inspector");
      return;
    }
    const sectionButton = event.target.closest("[data-inspector-section]");
    if (sectionButton) {
      state.inspectorSection = sectionButton.dataset.inspectorSection;
      renderInspector();
      return;
    }
    const componentButton = event.target.closest("[data-component]");
    if (componentButton) {
      selectSubsystem(state.selectedSubsystemId, componentButton.dataset.component);
      return;
    }
    const systemButton = event.target.closest("[data-related-system]");
    if (systemButton) {
      selectSubsystem(systemButton.dataset.relatedSystem, null, { focusInspector: true });
      return;
    }
    if (event.target.closest("[data-fly-to]")) {
      flyTo(state.selectedSubsystemId);
      return;
    }
    const copyButton = event.target.closest("[data-copy-path]");
    if (copyButton) {
      void copyPath(copyButton.dataset.copyPath);
    }
  });

  elements.flowSelect.addEventListener("change", () => {
    const flowId = elements.flowSelect.value;
    stopFlow();
    state.activeFlowId = flowId;
    setFlowStep(0);
  });
  elements.flowPrev.addEventListener("click", () => setFlowStep(state.activeFlowStep - 1));
  elements.flowNext.addEventListener("click", () => setFlowStep(state.activeFlowStep + 1));
  elements.flowPlay.addEventListener("click", toggleFlow);
  elements.flowRail.addEventListener("click", (event) => {
    const button = event.target.closest("[data-flow-step]");
    if (button) setFlowStep(Number.parseInt(button.dataset.flowStep, 10));
  });
  elements.traceDeck.addEventListener("click", (event) => {
    if (event.target.closest('[data-close-panel="trace"]')) closeWorkspace("trace");
  });

  elements.rotateLeft.addEventListener("click", () => rotateCamera(-0.16));
  elements.rotateRight.addEventListener("click", () => rotateCamera(0.16));
  elements.zoomIn.addEventListener("click", () => zoomCamera(0.12));
  elements.zoomOut.addEventListener("click", () => zoomCamera(-0.12));
  elements.resetView.addEventListener("click", resetCamera);

  elements.world.addEventListener("pointerdown", worldPointerDown);
  elements.world.addEventListener("pointermove", worldPointerMove);
  elements.world.addEventListener("pointerup", worldPointerUp);
  elements.world.addEventListener("pointercancel", worldPointerUp);
  elements.world.addEventListener("pointerleave", () => {
    if (!state.drag) hideHover();
  });
  elements.world.addEventListener("click", worldClicked);
  elements.world.addEventListener("dblclick", worldDoubleClicked);
  elements.world.addEventListener("wheel", worldWheeled, { passive: false });
  elements.world.addEventListener("keydown", worldKeyDown);

  elements.helpButton.addEventListener("click", () => elements.helpDialog.showModal());
  window.addEventListener("hashchange", () => {
    if (restoreSelectionFromHash()) {
      showWorkspace("inspector");
      renderAll();
      revealWorkspace("inspector");
    }
  });
  document.addEventListener("keydown", documentKeyDown);
}

function renderAll() {
  renderLensCopy();
  renderSystemList();
  renderSearchResults();
  renderInspector();
  renderFlow();
  renderWorld();
}

function renderLensSwitcher() {
  const focus = captureDataFocus(elements.lenses, ["data-lens"]);
  elements.lenses.replaceChildren(...ATLAS_LENSES.map((lens) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.lens = lens.id;
    button.innerHTML = `<span class="lens-label-full">${escapeHtml(lens.label)}</span><span class="lens-label-short">${escapeHtml(lens.shortLabel)}</span>`;
    button.classList.toggle("is-active", lens.id === state.lens);
    button.setAttribute("aria-pressed", String(lens.id === state.lens));
    return button;
  }));
  restoreDataFocus(elements.lenses, focus);
}

function renderLensCopy() {
  const lens = ATLAS_LENSES.find((candidate) => candidate.id === state.lens) ?? ATLAS_LENSES[0];
  elements.atlas.classList.remove(...ATLAS_LENSES.map((candidate) => `lens-${candidate.id}`));
  elements.atlas.classList.add(`lens-${lens.id}`);
  elements.lensCode.textContent = lens.label;
  elements.lensSummary.textContent = lens.summary;
}

function selectLens(lensId) {
  if (!ATLAS_LENSES.some((lens) => lens.id === lensId)) return;
  state.lens = lensId;
  renderLensSwitcher();
  renderLensCopy();
  renderInspector();
  renderWorld();
}

function renderWorkspace() {
  const panels = {
    systems: elements.systemIndex,
    inspector: elements.inspector,
    trace: elements.traceDeck,
  };
  for (const [panel, element] of Object.entries(panels)) {
    const active = state.activePanel === panel;
    elements.atlas.classList.toggle(`is-${panel}-closed`, !active);
    element.inert = !active;
    element.setAttribute("aria-hidden", String(!active));
  }
  const keyActive = state.activePanel === "key";
  elements.mapKey.hidden = !keyActive;
  for (const button of elements.workspaceSwitcher.querySelectorAll("[data-workspace-panel]")) {
    const active = button.dataset.workspacePanel === state.activePanel;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    if (button.dataset.workspacePanel === "key") {
      button.setAttribute("aria-expanded", String(active));
    }
  }
}

function showWorkspace(panel) {
  if (panel !== null && !["systems", "inspector", "trace", "key"].includes(panel)) return;
  state.activePanel = panel;
  renderWorkspace();
}

function closeWorkspace(panel) {
  showWorkspace(null);
  elements.workspaceSwitcher.querySelector(`[data-workspace-panel="${panel}"]`)?.focus();
}

function revealWorkspace(panel) {
  if (!stackedWorkspace.matches || panel === "key") return;
  const targets = {
    systems: elements.systemIndex,
    inspector: elements.inspector,
    trace: elements.traceDeck,
  };
  const target = targets[panel];
  if (!target) return;
  requestAnimationFrame(() => {
    target.scrollIntoView({
      behavior: motionPreference.matches ? "auto" : "smooth",
      block: "start",
    });
    if (panel === "inspector") elements.inspector.querySelector("#inspector-title")?.focus({ preventScroll: true });
    if (panel === "trace") elements.flowSelect.focus({ preventScroll: true });
  });
}

function renderSystemList() {
  const focus = captureDataFocus(elements.systems, ["data-system"]);
  const matches = matchedSubsystems();
  const sections = ATLAS_DISTRICTS.map((district) => {
    const rows = district.systems.map((id) => {
      const subsystem = architectureSubsystem(id);
      const detail = atlasDetail(id);
      const archetype = atlasArchetype(detail.archetype);
      const classes = [
        "system-row",
        `tone-${district.id}`,
        id === state.selectedSubsystemId ? "is-selected" : "",
        matches && !matches.has(id) ? "is-muted" : "",
      ].filter(Boolean).join(" ");
      return `
        <button class="${classes}" type="button" data-system="${id}">
          <i></i>
          <span>
            <strong>${escapeHtml(subsystem.shortLabel)}</strong>
            <small>${escapeHtml(archetype.label)}</small>
          </span>
          <em>${String(subsystem.components.length).padStart(2, "0")}</em>
        </button>`;
    }).join("");
    return `<section><h2>${escapeHtml(district.label)}</h2>${rows}</section>`;
  }).join("");
  elements.systems.innerHTML = sections;
  restoreDataFocus(elements.systems, focus);
}

function searchAtlas(query) {
  if (!query.trim()) return [];
  const base = searchArchitecture(query);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const known = new Set(base.map((result) => `${result.subsystemId}:${result.componentId ?? ""}`));
  const augmented = [...base];
  for (const subsystem of ARCHITECTURE_SUBSYSTEMS) {
    const detail = atlasDetail(subsystem.id);
    const district = atlasDistrictForSystem(subsystem.id);
    const archetype = atlasArchetype(detail.archetype);
    const text = [
      detail.scope,
      district.label,
      district.summary,
      archetype.label,
      archetype.summary,
      detail.runtime,
      detail.owner,
      detail.persistence,
      detail.admission,
      detail.completion,
      ...detail.security,
      ...detail.docs,
      ...detail.tests,
    ].join(" ").toLowerCase();
    if (terms.every((term) => text.includes(term)) && !known.has(`${subsystem.id}:`)) {
      augmented.push({
        subsystemId: subsystem.id,
        label: subsystem.label,
        path: subsystem.sourceRoot,
        summary: detail.owner,
        score: 2,
      });
    }
  }
  return augmented.slice(0, 18);
}

function renderSearchResults() {
  if (!state.searchQuery) {
    elements.searchResults.hidden = true;
    elements.searchResults.replaceChildren();
    return;
  }
  elements.searchResults.hidden = false;
  if (state.searchResults.length === 0) {
    elements.searchResults.innerHTML = "<p>NO MATCHES FOUND</p>";
    return;
  }
  elements.searchResults.innerHTML = state.searchResults.map((result, index) => {
    const subsystem = architectureSubsystem(result.subsystemId);
    return `
      <button type="button" data-result-index="${index}">
        <span>${escapeHtml(subsystem.shortLabel)}</span>
        <strong>${escapeHtml(result.label)}</strong>
        <small>${escapeHtml(result.summary)}</small>
      </button>`;
  }).join("");
}

function matchedSubsystems() {
  if (!state.searchQuery) return null;
  return new Set(state.searchResults.map((result) => result.subsystemId));
}

function clearSearch() {
  state.searchQuery = "";
  state.searchResults = [];
  elements.search.value = "";
  renderSearchResults();
  renderSystemList();
}

function selectSubsystem(subsystemId, componentId = null, options = {}) {
  const subsystem = ARCHITECTURE_SUBSYSTEMS.find((candidate) => candidate.id === subsystemId);
  if (!subsystem) return;
  const component = componentId ? architectureComponent(subsystemId, componentId) : null;
  state.selectedSubsystemId = subsystemId;
  state.selectedComponentId = component?.id ?? null;
  state.inspectorSection = component ? "components" : "overview";
  showWorkspace("inspector");
  updateHash();
  renderSystemList();
  renderInspector();
  renderWorld();
  if (options.fly) flyTo(subsystemId);
  if (options.focusInspector) focusInspectorHeading();
  if (options.reveal) revealWorkspace("inspector");
}

function updateHash() {
  const parts = [state.selectedSubsystemId];
  if (state.selectedComponentId) parts.push(state.selectedComponentId);
  const next = `#${parts.map(encodeURIComponent).join("/")}`;
  if (window.location.hash !== next) history.replaceState(null, "", next);
}

function restoreSelectionFromHash() {
  const raw = window.location.hash.slice(1);
  if (!raw) return false;
  const [systemPart, componentPart] = raw.split("/");
  const subsystemId = decodeURIComponent(systemPart ?? "");
  const subsystem = ARCHITECTURE_SUBSYSTEMS.find((candidate) => candidate.id === subsystemId);
  if (!subsystem) return false;
  const componentId = componentPart ? decodeURIComponent(componentPart) : null;
  state.selectedSubsystemId = subsystem.id;
  state.selectedComponentId = componentId && architectureComponent(subsystem.id, componentId) ? componentId : null;
  state.inspectorSection = state.selectedComponentId ? "components" : "overview";
  return true;
}

function renderInspector() {
  const focus = captureDataFocus(elements.inspector, [
    "data-component",
    "data-related-system",
    "data-fly-to",
    "data-copy-path",
    "data-close-panel",
    "data-inspector-section",
  ]);
  const subsystem = architectureSubsystem(state.selectedSubsystemId);
  const component = architectureComponent(subsystem.id, state.selectedComponentId);
  const detail = atlasDetail(subsystem.id);
  const district = atlasDistrictForSystem(subsystem.id);
  const archetype = atlasArchetype(detail.archetype);
  const systemNumber = ARCHITECTURE_SUBSYSTEMS.findIndex((candidate) => candidate.id === subsystem.id) + 1;
  const sourcePaths = component
    ? component.paths
    : [subsystem.sourceRoot, ...subsystem.components.map((candidate) => candidate.paths[0])];
  const relatedEdges = ARCHITECTURE_EDGES.filter(
    (edge) => edge.from === subsystem.id || edge.to === subsystem.id,
  );
  const componentProfile = component ? `
    <section class="component-profile">
      <div class="section-label"><span>YOU PICKED THIS SMALLER PART</span><i></i></div>
      <h3>${escapeHtml(component.label)}</h3>
      <strong class="component-plain-label">WHAT IT DOES · ${escapeHtml(component.plainLabel)}</strong>
      <p>${escapeHtml(component.summary)}</p>
      <ol>${component.mechanics.map((mechanic) => `<li>${escapeHtml(mechanic)}</li>`).join("")}</ol>
    </section>` : "";
  const overviewContent = `
    <section class="city-form-panel">
      <div>
        <strong>GROUP · ${escapeHtml(district.label)}</strong>
        <p>${escapeHtml(district.summary)}</p>
      </div>
      <div>
        <strong>SHAPE · ${escapeHtml(archetype.label)}</strong>
        <p>${escapeHtml(archetype.summary)}</p>
        <em>THIS SHAPE IS A VISUAL CLUE, NOT A MEASUREMENT.</em>
      </div>
      <small>COLOR SHOWS THE GROUP. SHAPE AND SIZE SHOW THE KIND OF JOB. BIGGER NEVER MEANS BETTER, BUSIER, OR MORE IMPORTANT.</small>
    </section>
    <p class="system-summary">${escapeHtml(subsystem.summary)}</p>

    <section class="evidence-grid">
      ${factCard("WHAT IT IS", detail.runtime, "runtime")}
      ${factCard("WHAT IT HANDLES", detail.owner, "ownership")}
      ${factCard("WHAT IT REMEMBERS", detail.persistence, "durability")}
      ${factCard("BEFORE IT ACTS", detail.admission, "security")}
      ${factCard("WHEN IT IS DONE", detail.completion, "ownership")}
    </section>

    <section class="invariant-panel">
      <div class="section-label"><span>WHERE ITS JOB STOPS</span><i></i></div>
      <p>${escapeHtml(subsystem.boundary)}</p>
      <div class="invariant-callout">
        <strong>ONE RULE THAT MUST NEVER BREAK</strong>
        <p>${escapeHtml(subsystem.invariant)}</p>
      </div>
    </section>

    <section class="security-facts">
      <div class="section-label"><span>HOW IT KEEPS YOU SAFE</span><i></i></div>
      <ul>${detail.security.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>
    </section>`;
  const componentsContent = `
    ${componentProfile}
    <section class="component-index">
      <div class="section-label"><span>SMALLER PARTS / ${subsystem.components.length}</span><i></i></div>
      ${subsystem.components.map((candidate, index) => `
        <button type="button" data-component="${candidate.id}" class="${candidate.id === component?.id ? "is-selected" : ""}">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>${escapeHtml(candidate.label)}</strong>
            <small>${escapeHtml(candidate.plainLabel)}</small>
            <p>${escapeHtml(candidate.summary)}</p>
          </div>
        </button>`).join("")}
    </section>`;
  const sourceContent = `
    <section class="source-evidence">
      <div class="section-label"><span>FOR PEOPLE READING THE CODE</span><i></i></div>
      ${unique(sourcePaths).map((path) => sourceRow(path, "source")).join("")}
      <details>
        <summary>HELPFUL EXPLANATIONS / ${detail.docs.length}</summary>
        ${detail.docs.map((path) => sourceRow(path, "document")).join("")}
      </details>
      <details>
        <summary>AUTOMATED CHECKS / ${detail.tests.length}</summary>
        ${detail.tests.map((path) => sourceRow(path, "test")).join("")}
      </details>
    </section>`;
  const routesContent = `
    <section class="route-index">
      <div class="section-label"><span>WHAT IT TALKS TO / ${relatedEdges.length}</span><i></i></div>
      ${relatedEdges.map((edge) => {
        const otherId = edge.from === subsystem.id ? edge.to : edge.from;
        const direction = edge.kind === "contract"
          ? "CONNECTED TO"
          : edge.from === subsystem.id
            ? "SENDS TO"
            : "RECEIVES FROM";
        return `
          <button type="button" data-related-system="${otherId}">
            <span class="route-kind is-${edge.kind}">${EDGE_WORDS[edge.kind]}</span>
            <div><strong>${direction} · ${escapeHtml(architectureSubsystem(otherId).shortLabel)}</strong><small>${escapeHtml(edge.label)}</small></div>
            <i>↗</i>
          </button>`;
      }).join("")}
    </section>`;
  const inspectorSections = {
    overview: overviewContent,
    components: componentsContent,
    source: sourceContent,
    routes: routesContent,
  };
  if (!inspectorSections[state.inspectorSection]) state.inspectorSection = "overview";

  elements.inspector.dataset.district = district.id;
  elements.inspector.innerHTML = `
    <header class="inspector-header">
      <div class="system-serial">PLACE ${String(systemNumber).padStart(2, "0")}</div>
      <button class="panel-close" type="button" data-close-panel="inspector" aria-label="Close details">×</button>
      <p>${escapeHtml(district.shortLabel)} / ${escapeHtml(archetype.label)}</p>
      <h2 id="inspector-title" tabindex="-1">${escapeHtml(subsystem.label)}</h2>
      <button class="inspector-fly" type="button" data-fly-to>CENTER ON MAP ↗</button>
    </header>

    <div class="inspector-scroll">
      <nav class="inspector-tabs" aria-label="Choose what you want to learn">
        ${[
          ["overview", "BIG PICTURE"],
          ["components", `SMALLER PARTS ${subsystem.components.length}`],
          ["source", "CODE"],
          ["routes", `CONNECTIONS ${relatedEdges.length}`],
        ].map(([section, label]) => `
          <button type="button" data-inspector-section="${section}" class="${section === state.inspectorSection ? "is-active" : ""}" aria-pressed="${section === state.inspectorSection}">${label}</button>`).join("")}
      </nav>
      <div class="inspector-view" data-inspector-view="${state.inspectorSection}">
        ${inspectorSections[state.inspectorSection]}
      </div>
    </div>`;
  restoreDataFocus(elements.inspector, focus);
}

function factCard(label, value, lens) {
  return `
    <article class="fact-card fact-${lens}${state.lens === lens ? " is-emphasized" : ""}">
      <strong>${escapeHtml(label)}</strong>
      <p>${escapeHtml(value)}</p>
    </article>`;
}

function sourceRow(path, kind) {
  const route = path.endsWith("/") ? "tree" : "blob";
  const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const encodedRef = state.sha.split("/").map(encodeURIComponent).join("/");
  const href = `${state.sourceBase}/${route}/${encodedRef}/${encodedPath}`;
  return `
    <div class="source-row">
      <span>${kind === "test" ? "✓" : kind === "document" ? "§" : "⌁"}</span>
      <a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(path)}</a>
      <button type="button" data-copy-path="${escapeAttribute(path)}" aria-label="Copy ${escapeAttribute(path)}">COPY FILE PATH</button>
    </div>`;
}

function renderFlowOptions() {
  elements.flowSelect.replaceChildren(...ARCHITECTURE_FLOWS.map((flow) => {
    const option = document.createElement("option");
    option.value = flow.id;
    option.textContent = flow.label;
    return option;
  }));
  elements.flowSelect.value = state.activeFlowId;
}

function activeFlow() {
  return ARCHITECTURE_FLOWS.find((flow) => flow.id === state.activeFlowId) ?? ARCHITECTURE_FLOWS[0];
}

function renderFlow() {
  const focus = captureDataFocus(elements.flowRail, ["data-flow-step"]);
  const flow = activeFlow();
  const step = flow.steps[state.activeFlowStep] ?? flow.steps[0];
  const notes = ATLAS_TOUR_NOTES[flow.id];
  elements.flowSelect.value = flow.id;
  elements.flowStepNumber.textContent = String(state.activeFlowStep + 1).padStart(2, "0");
  elements.flowStepSystem.textContent = architectureSubsystem(step.subsystemId).shortLabel;
  elements.flowStepTitle.textContent = step.label;
  elements.flowStepDetail.textContent = step.detail;
  elements.flowPrev.disabled = state.activeFlowStep === 0;
  elements.flowNext.disabled = state.activeFlowStep === flow.steps.length - 1;
  elements.flowPlay.textContent = state.playing ? "Ⅱ" : "▶";
  elements.flowPlay.setAttribute("aria-label", state.playing ? "Pause the story" : "Play the story");
  elements.flowRail.innerHTML = flow.steps.map((candidate, index) => {
    const classes = [
      index === state.activeFlowStep ? "is-active" : "",
      index < state.activeFlowStep ? "is-complete" : "",
    ].filter(Boolean).join(" ");
    return `
      <button type="button" data-flow-step="${index}" class="${classes}" aria-current="${index === state.activeFlowStep ? "step" : "false"}">
        <i></i>
        <span>${String(index + 1).padStart(2, "0")}</span>
        <small>${escapeHtml(architectureSubsystem(candidate.subsystemId).shortLabel)}</small>
      </button>`;
  }).join("");
  elements.flowThesis.innerHTML = notes
    ? `<strong>MAIN IDEA</strong> ${escapeHtml(notes.thesis)} <em>${escapeHtml(notes.warning)}</em>`
    : escapeHtml(flow.summary);
  restoreDataFocus(elements.flowRail, focus);
}

function setFlowStep(index) {
  const flow = activeFlow();
  const next = Math.max(0, Math.min(flow.steps.length - 1, index));
  state.activeFlowStep = next;
  const step = flow.steps[next];
  state.selectedSubsystemId = step.subsystemId;
  state.selectedComponentId = step.componentId ?? null;
  state.inspectorSection = step.componentId ? "components" : "overview";
  updateHash();
  renderFlow();
  renderSystemList();
  renderInspector();
  renderWorld();
}

function toggleFlow() {
  if (state.playing) {
    stopFlow();
    return;
  }
  const flow = activeFlow();
  if (state.activeFlowStep === flow.steps.length - 1) state.activeFlowStep = 0;
  state.playing = true;
  renderFlow();
  state.playTimer = window.setInterval(() => {
    const current = activeFlow();
    if (state.activeFlowStep >= current.steps.length - 1) {
      stopFlow();
      return;
    }
    setFlowStep(state.activeFlowStep + 1);
  }, 2800);
}

function stopFlow() {
  state.playing = false;
  if (state.playTimer) window.clearInterval(state.playTimer);
  state.playTimer = 0;
  renderFlow();
}

function renderWorld() {
  const focus = captureDataFocus(elements.world, ["data-component", "data-system"]);
  const matches = matchedSubsystems();
  const flow = activeFlow();
  const flowStates = new Map();
  flow.steps.forEach((step, index) => {
    const previous = flowStates.get(step.subsystemId) ?? -1;
    flowStates.set(step.subsystemId, Math.max(previous, index));
  });
  const connected = new Set();
  for (const edge of ARCHITECTURE_EDGES) {
    if (edge.from === state.selectedSubsystemId) connected.add(edge.to);
    if (edge.to === state.selectedSubsystemId) connected.add(edge.from);
  }

  const towers = ARCHITECTURE_SUBSYSTEMS.map((subsystem) => {
    const scene = atlasScene(subsystem);
    return {
      subsystem,
      detail: atlasDetail(subsystem.id),
      scene,
      depth: project({ x: scene.x, y: scene.height / 2, z: scene.z }).depth,
    };
  }).sort((left, right) => left.depth - right.depth);

  const ground = renderGround(towers);
  const parcels = state.lens === "ownership" ? renderOwnershipParcels(towers) : "";
  const foundations = state.lens === "durability"
    ? towers.filter(({ detail }) => detail.foundation)
      .map(({ subsystem, detail, scene }) => renderFoundation(subsystem, detail, scene)).join("")
    : "";
  const routes = renderRoutes();
  const traceRoutes = renderTraceRoutes(flow);
  const nodes = towers.map(({ subsystem, detail, scene }) => {
    const flowIndex = flowStates.get(subsystem.id);
    return renderTower(subsystem, detail, scene, {
      selected: subsystem.id === state.selectedSubsystemId,
      connected: connected.has(subsystem.id),
      matched: !matches || matches.has(subsystem.id),
      traceState: flowIndex === undefined
        ? "none"
        : flowIndex < state.activeFlowStep
          ? "complete"
          : flowIndex === state.activeFlowStep
            ? "active"
            : "future",
    });
  }).join("");

  elements.scene.innerHTML = `${ground}${parcels}${foundations}${routes}${traceRoutes}${nodes}`;
  restoreDataFocus(elements.world, focus);
  updateCameraReadout();
}

function renderGround(towers) {
  const grid = [];
  const outerRadius = ATLAS_ZONES.find((zone) => zone.id === "outer")?.radius ?? 270;
  const boundaryRadius = ATLAS_ZONES.find((zone) => zone.id === "boundary")?.radius ?? 164;
  const gridExtent = outerRadius + 30;
  for (let coordinate = -gridExtent; coordinate <= gridExtent; coordinate += 20) {
    grid.push(`<path d="${linePath(
      { x: coordinate, y: 0, z: -gridExtent },
      { x: coordinate, y: 0, z: gridExtent },
    )}" class="terrain-grid-line"></path>`);
    grid.push(`<path d="${linePath(
      { x: -gridExtent, y: 0, z: coordinate },
      { x: gridExtent, y: 0, z: coordinate },
    )}" class="terrain-grid-line"></path>`);
  }
  const zones = [...ATLAS_ZONES].reverse().map((zone, index) => {
    const points = [];
    for (let angle = 0; angle <= Math.PI * 2 + 0.01; angle += Math.PI / 40) {
      points.push({ x: Math.cos(angle) * zone.radius, y: 0, z: Math.sin(angle) * zone.radius });
    }
    const labelPoint = project({
      x: -zone.radius * 0.78,
      y: 0,
      z: -zone.radius * 0.62,
    });
    return `
      <path d="${pointPath(points)}" class="terrain-zone zone-${zone.id} zone-${index}"></path>
      <text x="${format(labelPoint.x)}" y="${format(labelPoint.y - 8)}" class="zone-label zone-label-${zone.id}">${escapeHtml(zone.label)}</text>`;
  }).join("");
  const gateLeft = project({ x: -28, y: 0, z: -boundaryRadius });
  const gateLeftTop = project({ x: -28, y: 34, z: -boundaryRadius });
  const gateRight = project({ x: 28, y: 0, z: -boundaryRadius });
  const gateRightTop = project({ x: 28, y: 34, z: -boundaryRadius });
  const districts = renderDistricts(towers);
  return `
    <path d="${pointPath(circlePoints(outerRadius), true)}" class="terrain-field"></path>
    <g class="terrain-grid">${grid.join("")}</g>
    <g class="terrain-districts">${districts}</g>
    <g class="terrain-zones">${zones}</g>
    <g class="installation-gate">
      <path d="M ${format(gateLeft.x)} ${format(gateLeft.y)} L ${format(gateLeftTop.x)} ${format(gateLeftTop.y)}"></path>
      <path d="M ${format(gateRight.x)} ${format(gateRight.y)} L ${format(gateRightTop.x)} ${format(gateRightTop.y)}"></path>
      <path d="M ${format(gateLeftTop.x)} ${format(gateLeftTop.y)} Q ${format((gateLeftTop.x + gateRightTop.x) / 2)} ${format(Math.min(gateLeftTop.y, gateRightTop.y) - 26)} ${format(gateRightTop.x)} ${format(gateRightTop.y)}"></path>
      <text x="${format((gateLeftTop.x + gateRightTop.x) / 2)}" y="${format(Math.min(gateLeftTop.y, gateRightTop.y) - 32)}">PRIVATE ENTRY CHECK</text>
    </g>`;
}

function renderDistricts(towers) {
  return ATLAS_DISTRICTS.map((district) => {
    const offsetIds = Object.keys(district.layout.offsets ?? {});
    const mainIds = district.systems.filter((id) => !offsetIds.includes(id));
    const groups = [mainIds, ...offsetIds.map((id) => [id])].filter((ids) => ids.length > 0);
    return groups.map((ids, groupIndex) => {
      const districtTowers = towers.filter(({ subsystem }) => ids.includes(subsystem.id));
      const padding = district.zone === "outer" ? 2 : district.id === "contract-causeway" ? 9 : 12;
      const minX = Math.min(...districtTowers.map(({ scene }) => scene.x - scene.width / 2)) - padding;
      const maxX = Math.max(...districtTowers.map(({ scene }) => scene.x + scene.width / 2)) + padding;
      const minZ = Math.min(...districtTowers.map(({ scene }) => scene.z - scene.depth / 2)) - padding;
      const maxZ = Math.max(...districtTowers.map(({ scene }) => scene.z + scene.depth / 2)) + padding;
      const cut = Math.min(12, (maxX - minX) * 0.12, (maxZ - minZ) * 0.22);
      const points = [
        { x: minX + cut, y: 0.15, z: minZ },
        { x: maxX - cut, y: 0.15, z: minZ },
        { x: maxX, y: 0.15, z: minZ + cut },
        { x: maxX, y: 0.15, z: maxZ - cut },
        { x: maxX - cut, y: 0.15, z: maxZ },
        { x: minX + cut, y: 0.15, z: maxZ },
        { x: minX, y: 0.15, z: maxZ - cut },
        { x: minX, y: 0.15, z: minZ + cut },
      ];
      const label = project({ x: minX + cut + 4, y: 0.4, z: minZ + 7 });
      const labelMarkup = groupIndex === 0
        ? `<text x="${format(label.x)}" y="${format(label.y)}" class="district-label district-${district.id}">${escapeHtml(district.shortLabel)}</text>`
        : "";
      return `
        <path d="${pointPath(points, true)}" class="district-parcel district-${district.id}">
          <title>${escapeHtml(`${district.label}: ${district.summary}`)}</title>
        </path>
        ${labelMarkup}`;
    }).join("");
  }).join("");
}

function renderOwnershipParcels(towers) {
  return towers.map(({ subsystem, scene }) => {
    const district = atlasDistrictForSystem(subsystem.id);
    const padding = 8;
    const points = [
      { x: scene.x - scene.width / 2 - padding, y: 0.3, z: scene.z - scene.depth / 2 - padding },
      { x: scene.x + scene.width / 2 + padding, y: 0.3, z: scene.z - scene.depth / 2 - padding },
      { x: scene.x + scene.width / 2 + padding, y: 0.3, z: scene.z + scene.depth / 2 + padding },
      { x: scene.x - scene.width / 2 - padding, y: 0.3, z: scene.z + scene.depth / 2 + padding },
    ];
    return `<path d="${pointPath(points, true)}" class="ownership-parcel parcel-${district.id} ${subsystem.id === state.selectedSubsystemId ? "is-selected" : ""}"></path>`;
  }).join("");
}

function renderFoundation(subsystem, detail, scene) {
  const { x, z, width, depth } = scene;
  const bottom = -24;
  const base = boxCorners(x, z, width * 0.88, depth * 0.88, 0);
  const lower = boxCorners(x, z, width * 0.88, depth * 0.88, bottom);
  const faces = [
    [base[0], base[1], lower[1], lower[0]],
    [base[1], base[2], lower[2], lower[1]],
    [base[2], base[3], lower[3], lower[2]],
    [base[3], base[0], lower[0], lower[3]],
    lower,
  ];
  const label = project({ x, y: bottom - 3, z });
  return `
    <g class="foundation ${subsystem.id === state.selectedSubsystemId ? "is-selected" : ""}">
      ${faces.map((face) => `<path d="${pointPath(face, true)}"></path>`).join("")}
      <text x="${format(label.x)}" y="${format(label.y + 14)}">${escapeHtml(detail.foundation)}</text>
    </g>`;
}

function renderRoutes() {
  return ARCHITECTURE_EDGES.map((edge, index) => {
    const from = atlasScene(architectureSubsystem(edge.from));
    const to = atlasScene(architectureSubsystem(edge.to));
    const selected = edge.from === state.selectedSubsystemId || edge.to === state.selectedSubsystemId;
    const emphasized = state.lens === "security"
      ? edge.security === true
      : state.lens === "durability"
        ? edge.kind === "data"
        : state.lens === "ownership"
          ? selected
          : true;
    const path = routePath(from, to, 26 + (index % 4) * 7);
    const marker = edge.kind === "contract" ? "" : ' marker-end="url(#route-arrow)"';
    const connector = edge.kind === "contract" ? "↔" : "→";
    return `
      <path d="${path}" class="world-route route-${edge.kind}${selected ? " is-selected" : ""}${emphasized ? " is-emphasized" : ""}" stroke="${EDGE_COLORS[edge.kind]}"${marker}>
        <title>${escapeHtml(`${architectureSubsystem(edge.from).shortLabel} ${connector} ${architectureSubsystem(edge.to).shortLabel}: ${edge.label}`)}</title>
      </path>`;
  }).join("");
}

function renderTraceRoutes(flow) {
  const routes = [];
  for (let index = 1; index < flow.steps.length; index += 1) {
    const previous = flow.steps[index - 1];
    const current = flow.steps[index];
    if (previous.subsystemId === current.subsystemId) continue;
    const from = atlasScene(architectureSubsystem(previous.subsystemId));
    const to = atlasScene(architectureSubsystem(current.subsystemId));
    const phase = index < state.activeFlowStep
      ? "is-complete"
      : index === state.activeFlowStep
        ? "is-current"
        : "is-future";
    routes.push(`
      <path d="${routePath(from, to, 42 + (index % 3) * 8)}" class="trace-route ${phase}" marker-end="url(#route-arrow)">
        <title>${escapeHtml(`${previous.label} → ${current.label}`)}</title>
      </path>`);
  }
  return `<g class="trace-routes">${routes.join("")}</g>`;
}

function routePath(from, to, lift) {
  const start = project({ x: from.x, y: Math.min(from.height * 0.34, 26), z: from.z });
  const end = project({ x: to.x, y: Math.min(to.height * 0.34, 26), z: to.z });
  const middle = project({
    x: (from.x + to.x) / 2,
    y: lift,
    z: (from.z + to.z) / 2,
  });
  return `M ${format(start.x)} ${format(start.y)} Q ${format(middle.x)} ${format(middle.y)} ${format(end.x)} ${format(end.y)}`;
}

function renderTower(subsystem, detail, scene, flags) {
  const district = atlasDistrictForSystem(subsystem.id);
  const archetype = atlasArchetype(detail.archetype);
  const body = formBody(scene, detail.archetype);
  const prism = projectPrism(body.x, body.z, body.width, body.depth, 0, body.height);
  const topCenter = project({ x: scene.x, y: scene.height, z: scene.z });
  const groundCenter = project({ x: scene.x, y: 0, z: scene.z });
  const labelWidth = Math.max(86, subsystem.shortLabel.length * 7.2 + 34);
  const labelY = topCenter.y - 46;
  const classes = [
    "world-node",
    `node-${district.id}`,
    `form-${detail.archetype}`,
    flags.selected ? "is-selected" : "",
    flags.connected ? "is-connected" : "",
    !flags.matched ? "is-search-muted" : "",
    `trace-${flags.traceState}`,
  ].filter(Boolean).join(" ");
  const faceMarkup = renderPrism(prism, "tower");
  const apertureFace = prism.faces.find((face) => face.index === COMPONENT_FACADE_INDEX);
  const apertureVisible = prism.faces.slice(-2).includes(apertureFace);
  const components = apertureVisible ? renderComponentApertures(subsystem, apertureFace) : "";
  const formFeatures = renderFormFeatures(detail.archetype, scene, body);
  const selectedBeam = flags.selected ? `
    <ellipse cx="${format(groundCenter.x)}" cy="${format(groundCenter.y)}" rx="46" ry="22" class="selection-flare"></ellipse>
    <path d="M ${format(groundCenter.x)} ${format(groundCenter.y)} L ${format(topCenter.x)} ${format(topCenter.y - 92)}" class="selection-beam"></path>
    <circle cx="${format(topCenter.x)}" cy="${format(topCenter.y - 92)}" r="5" class="selection-orb"></circle>` : "";
  const badgeWidth = detail.gate ? Math.max(34, detail.gate.length * 6 + 12) : 0;
  const securityBadge = state.lens === "security" && detail.gate ? `
    <g class="security-badge" transform="translate(${format(topCenter.x + labelWidth / 2 + badgeWidth / 2 + 7)} ${format(labelY + 15)})">
      <rect x="${format(-badgeWidth / 2)}" y="-9" width="${format(badgeWidth)}" height="18" rx="2"></rect>
      <text y="3">${escapeHtml(detail.gate)}</text>
    </g>` : "";

  return `
    <g class="${classes}" data-system="${subsystem.id}" role="button" tabindex="0" aria-label="${escapeAttribute(subsystem.label)}; ${escapeAttribute(district.label)}; ${escapeAttribute(archetype.label)}; ${subsystem.components.length} smaller parts">
      ${selectedBeam}
      <g class="tower-geometry">
        ${faceMarkup}
        ${formFeatures}
        ${components}
        <path d="${screenPointPath(prism.base, true)}" class="tower-footprint"></path>
      </g>
      <g class="node-label" transform="translate(${format(topCenter.x - labelWidth / 2)} ${format(labelY)})">
        <path d="M ${format(labelWidth / 2)} 30 L ${format(labelWidth / 2)} ${format(topCenter.y - labelY - 4)}"></path>
        <rect width="${format(labelWidth)}" height="30" rx="2"></rect>
        <text x="10" y="19">${escapeHtml(subsystem.shortLabel)}</text>
        <text class="node-count" x="${format(labelWidth - 10)}" y="19" text-anchor="end">${String(subsystem.components.length).padStart(2, "0")}</text>
      </g>
      ${securityBadge}
    </g>`;
}

function formBody(scene, archetypeId) {
  const forms = {
    portal: { width: 0.42, depth: 0.72, height: 0.56 },
    "process-pods": { width: 0.48, depth: 0.72, height: 1 },
    "contract-lattice": { width: 1, depth: 1, height: 1 },
    terminal: { width: 0.76, depth: 0.78, height: 0.74 },
    campus: { width: 0.46, depth: 0.72, height: 1 },
    vault: { width: 0.38, depth: 0.42, height: 0.62, zOffset: -0.28 },
    yard: { width: 0.72, depth: 0.72, height: 0.48 },
  };
  const ratios = forms[archetypeId] ?? { width: 1, depth: 1, height: 1 };
  return {
    x: scene.x,
    z: scene.z + scene.depth * (ratios.zOffset ?? 0),
    width: scene.width * ratios.width,
    depth: scene.depth * ratios.depth,
    height: scene.facadeHeight * ratios.height,
  };
}

function projectPrism(x, z, width, depth, bottom, top) {
  const base = boxCorners(x, z, width, depth, bottom).map(project);
  const topFace = boxCorners(x, z, width, depth, top).map(project);
  const faces = [0, 1, 2, 3].map((index) => {
    const next = (index + 1) % 4;
    const points = [base[index], base[next], topFace[next], topFace[index]];
    return {
      index,
      points,
      depth: points.reduce((total, point) => total + point.depth, 0) / points.length,
    };
  }).sort((left, right) => left.depth - right.depth);
  return { base, topFace, faces };
}

function renderPrism(prism, className) {
  const faces = prism.faces.map((face) => `
    <path d="${screenPointPath(face.points, true)}" class="${className}-face face-${face.index}"></path>`).join("");
  return `${faces}<path d="${screenPointPath(prism.topFace, true)}" class="${className}-top"></path>`;
}

function renderComponentApertures(subsystem, face) {
  const count = subsystem.components.length;
  const columns = Math.ceil(Math.sqrt(count * 1.2));
  const rows = Math.ceil(count / columns);
  const cellWidth = 0.76 / columns;
  const cellHeight = 0.66 / rows;
  const apertures = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = 0.12 + column * cellWidth + cellWidth * 0.2;
    const right = left + cellWidth * 0.6;
    const cellBottom = 0.14 + (rows - row - 1) * cellHeight;
    const bottom = cellBottom + cellHeight * 0.23;
    const top = bottom + cellHeight * 0.54;
    const component = subsystem.components[index];
    const selected = component.id === state.selectedComponentId && subsystem.id === state.selectedSubsystemId;
    const points = [
      quadPoint(face.points, left, bottom),
      quadPoint(face.points, right, bottom),
      quadPoint(face.points, right, top),
      quadPoint(face.points, left, top),
    ];
    const hitPoints = [
      quadPoint(face.points, 0.12 + column * cellWidth + cellWidth * 0.05, cellBottom + cellHeight * 0.05),
      quadPoint(face.points, 0.12 + (column + 1) * cellWidth - cellWidth * 0.05, cellBottom + cellHeight * 0.05),
      quadPoint(face.points, 0.12 + (column + 1) * cellWidth - cellWidth * 0.05, cellBottom + cellHeight * 0.95),
      quadPoint(face.points, 0.12 + column * cellWidth + cellWidth * 0.05, cellBottom + cellHeight * 0.95),
    ];
    const path = screenPointPath(points, true);
    const hitPath = screenPointPath(hitPoints, true);
    apertures.push(`
      <path d="${hitPath}" class="component-hit" data-system="${subsystem.id}" data-component="${component.id}" data-face="${face.index}">
        <title>${escapeHtml(component.label)}</title>
      </path>
      <path d="${path}" class="component-aperture${selected ? " is-selected" : ""}" data-system="${subsystem.id}" data-component="${component.id}" data-face="${face.index}">
        <title>${escapeHtml(component.label)}</title>
      </path>`);
  }
  return apertures.join("");
}

function quadPoint(points, horizontal, vertical) {
  const lower = interpolate(points[0], points[1], horizontal);
  const upper = interpolate(points[3], points[2], horizontal);
  return interpolate(lower, upper, vertical);
}

function renderFormFeatures(archetypeId, scene, body) {
  const { x, z, width, depth, facadeHeight, height } = scene;
  const featurePrism = (centerX, centerZ, featureWidth, featureDepth, bottom, top) => (
    renderPrism(projectPrism(centerX, centerZ, featureWidth, featureDepth, bottom, top), "form-feature")
  );

  if (archetypeId === "portal") {
    const pylonWidth = width * 0.22;
    const pylonOffset = width * 0.34;
    return `
      ${featurePrism(x - pylonOffset, z, pylonWidth, depth * 0.88, 0, height)}
      ${featurePrism(x + pylonOffset, z, pylonWidth, depth * 0.88, 0, height)}
      ${featurePrism(x, z, width * 0.7, depth * 0.42, facadeHeight * 0.38, facadeHeight * 0.54)}
      ${renderPortalFrame(scene)}`;
  }
  if (archetypeId === "citadel") {
    return `
      ${featurePrism(x - width * 0.39, z, width * 0.22, depth * 0.72, 0, facadeHeight * 0.42)}
      ${featurePrism(x + width * 0.39, z, width * 0.22, depth * 0.72, 0, facadeHeight * 0.42)}
      ${featurePrism(x, z, width * 0.34, depth * 0.62, facadeHeight, height)}
      ${featurePrism(x - width * 0.28, z, width * 0.1, depth * 0.36, facadeHeight * 0.7, height * 0.88)}
      ${featurePrism(x + width * 0.28, z, width * 0.1, depth * 0.36, facadeHeight * 0.7, height * 0.88)}
      ${renderCircuitSpine(scene, 0.64)}`;
  }
  if (archetypeId === "process-pods") {
    return `
      ${featurePrism(x - width * 0.34, z, width * 0.28, depth, 0, facadeHeight * 0.62)}
      ${featurePrism(x + width * 0.34, z, width * 0.28, depth, 0, facadeHeight * 0.62)}
      ${featurePrism(x, z, body.width * 0.42, body.depth * 0.62, facadeHeight, height)}
      ${renderPodLinks(scene)}`;
  }
  if (archetypeId === "archive") {
    return `
      ${featurePrism(x, z, width * 0.88, depth * 0.88, facadeHeight, facadeHeight + scene.crownHeight * 0.28)}
      ${featurePrism(x, z, width * 0.7, depth * 0.7, facadeHeight + scene.crownHeight * 0.28, facadeHeight + scene.crownHeight * 0.62)}
      ${featurePrism(x, z, width * 0.48, depth * 0.5, facadeHeight + scene.crownHeight * 0.62, height)}
      ${renderCircuitSpine(scene, 0.5)}`;
  }
  if (archetypeId === "contract-lattice") {
    return renderLattice(scene, body.height);
  }
  if (archetypeId === "contract-hall") {
    return `
      ${featurePrism(x, z, width * 0.92, depth * 0.74, facadeHeight, facadeHeight + scene.crownHeight * 0.3)}
      ${featurePrism(x - width * 0.31, z, width * 0.08, depth * 0.46, facadeHeight * 0.48, height)}
      ${featurePrism(x + width * 0.31, z, width * 0.08, depth * 0.46, facadeHeight * 0.48, height)}
      ${renderLightRail(scene, facadeHeight + scene.crownHeight * 0.62)}`;
  }
  if (archetypeId === "workshop") {
    return `
      ${featurePrism(x - width * 0.3, z, width * 0.09, depth * 0.72, facadeHeight * 0.42, height * 0.86)}
      ${featurePrism(x, z, width * 0.09, depth * 0.72, facadeHeight * 0.32, height)}
      ${featurePrism(x + width * 0.3, z, width * 0.09, depth * 0.72, facadeHeight * 0.42, height * 0.86)}
      ${renderWorkBays(scene)}`;
  }
  if (archetypeId === "exchange") {
    return `
      ${featurePrism(x, z, width * 0.52, depth * 0.52, facadeHeight, facadeHeight + scene.crownHeight * 0.32)}
      ${featurePrism(x, z, width * 0.1, depth * 0.28, facadeHeight + scene.crownHeight * 0.32, height * 0.92)}
      ${renderExchangeMast(scene)}`;
  }
  if (archetypeId === "terminal") {
    return `
      ${featurePrism(x, z - depth * 0.36, width, depth * 0.14, body.height * 0.42, body.height * 0.54)}
      ${featurePrism(x, z + depth * 0.22, body.width * 0.72, depth * 0.1, body.height * 0.6, height)}
      ${featurePrism(x, z, width * 0.92, depth * 0.66, body.height, body.height + scene.crownHeight * 0.22)}
      ${renderLightRail(scene, body.height * 0.58)}`;
  }
  if (archetypeId === "campus") {
    return `
      ${featurePrism(x - width * 0.35, z, width * 0.3, depth, 0, facadeHeight * 0.58)}
      ${featurePrism(x + width * 0.35, z, width * 0.3, depth, 0, facadeHeight * 0.58)}
      ${featurePrism(x, z, body.width * 0.44, body.depth * 0.5, facadeHeight, height)}
      ${renderCampusLinks(scene)}`;
  }
  if (archetypeId === "vault") {
    const cellDepth = depth * 0.52;
    const cellWidth = width * 0.27;
    const cellZ = z + depth * 0.18;
    return `
      ${featurePrism(x - width * 0.3, cellZ, cellWidth, cellDepth, 0, facadeHeight * 0.78)}
      ${featurePrism(x, cellZ + depth * 0.08, cellWidth, cellDepth, 0, facadeHeight)}
      ${featurePrism(x + width * 0.3, cellZ, cellWidth, cellDepth, 0, facadeHeight * 0.78)}
      ${featurePrism(x - width * 0.3, cellZ, cellWidth * 0.34, cellDepth * 0.62, facadeHeight * 0.78, height * 0.84)}
      ${featurePrism(x, cellZ + depth * 0.08, cellWidth * 0.34, cellDepth * 0.62, facadeHeight, height)}
      ${featurePrism(x + width * 0.3, cellZ, cellWidth * 0.34, cellDepth * 0.62, facadeHeight * 0.78, height * 0.84)}
      ${renderVaultBus(scene)}`;
  }
  if (archetypeId === "yard") {
    return `${featurePrism(x, z, width * 0.92, depth * 0.82, body.height, body.height + 3)}${renderGantry(scene, body.height)}`;
  }
  return `${featurePrism(x, z, width * 0.28, depth * 0.5, facadeHeight, height)}${renderCircuitSpine(scene, 0.5)}`;
}

function renderPortalFrame(scene) {
  const front = scene.z - scene.depth / 2 - 0.3;
  const leftBottom = { x: scene.x - scene.width * 0.24, y: 2, z: front };
  const leftTop = { ...leftBottom, y: scene.height * 0.72 };
  const rightBottom = { x: scene.x + scene.width * 0.24, y: 2, z: front };
  const rightTop = { ...rightBottom, y: scene.height * 0.72 };
  return `<g class="portal-frame">
    <path d="${linePath(leftBottom, leftTop)}"></path>
    <path d="${linePath(leftTop, rightTop)}"></path>
    <path d="${linePath(rightTop, rightBottom)}"></path>
  </g>`;
}

function renderCircuitSpine(scene, widthRatio) {
  const front = scene.z - scene.depth / 2 - 0.2;
  const left = scene.x - scene.width * widthRatio / 2;
  const right = scene.x + scene.width * widthRatio / 2;
  const middleY = scene.facadeHeight * 0.58;
  const paths = [
    linePath({ x: left, y: 3, z: front }, { x: left, y: middleY, z: front }),
    linePath({ x: left, y: middleY, z: front }, { x: scene.x, y: middleY, z: front }),
    linePath({ x: scene.x, y: middleY, z: front }, { x: scene.x, y: scene.height, z: front }),
    linePath({ x: scene.x, y: scene.height * 0.78, z: front }, { x: right, y: scene.height * 0.78, z: front }),
  ];
  return `<g class="form-circuit">${paths.map((path) => `<path d="${path}"></path>`).join("")}</g>`;
}

function renderPodLinks(scene) {
  const y = scene.facadeHeight * 0.42;
  const left = { x: scene.x - scene.width * 0.47, y, z: scene.z - scene.depth * 0.34 };
  const right = { x: scene.x + scene.width * 0.47, y, z: scene.z - scene.depth * 0.34 };
  const center = { x: scene.x, y: y + scene.crownHeight * 0.16, z: scene.z - scene.depth * 0.34 };
  return `<g class="form-link"><path d="${linePath(left, center)}"></path><path d="${linePath(center, right)}"></path></g>`;
}

function renderLightRail(scene, y) {
  const front = scene.z - scene.depth / 2 - 0.25;
  return `<g class="form-link"><path d="${linePath(
    { x: scene.x - scene.width * 0.46, y, z: front },
    { x: scene.x + scene.width * 0.46, y, z: front },
  )}"></path></g>`;
}

function renderWorkBays(scene) {
  const front = scene.z - scene.depth / 2 - 0.25;
  const paths = [-0.28, 0, 0.28].map((offset) => linePath(
    { x: scene.x + scene.width * offset - scene.width * 0.09, y: 3, z: front },
    { x: scene.x + scene.width * offset + scene.width * 0.09, y: 3, z: front },
  ));
  return `<g class="form-bays">${paths.map((path) => `<path d="${path}"></path>`).join("")}</g>`;
}

function renderCampusLinks(scene) {
  const y = scene.facadeHeight * 0.32;
  const front = scene.z - scene.depth * 0.32;
  return `<g class="form-link">
    <path d="${linePath({ x: scene.x - scene.width * 0.48, y, z: front }, { x: scene.x, y: y + 3, z: front })}"></path>
    <path d="${linePath({ x: scene.x, y: y + 3, z: front }, { x: scene.x + scene.width * 0.48, y, z: front })}"></path>
  </g>`;
}

function renderVaultBus(scene) {
  const front = scene.z - scene.depth * 0.08;
  const y = scene.facadeHeight * 0.48;
  return `<g class="form-link"><path d="${linePath(
    { x: scene.x - scene.width * 0.48, y, z: front },
    { x: scene.x + scene.width * 0.48, y, z: front },
  )}"></path></g>`;
}

function renderLattice(scene, platformHeight) {
  const lower = boxCorners(scene.x, scene.z, scene.width * 0.82, scene.depth * 0.68, platformHeight);
  const upper = boxCorners(scene.x, scene.z, scene.width * 0.82, scene.depth * 0.68, scene.height);
  const lines = [];
  for (let index = 0; index < lower.length; index += 1) {
    const next = (index + 1) % lower.length;
    lines.push(linePath(lower[index], upper[index]));
    lines.push(linePath(upper[index], upper[next]));
    lines.push(linePath(lower[index], upper[next]));
  }
  return `<g class="form-lattice">${lines.map((path) => `<path d="${path}"></path>`).join("")}</g>`;
}

function renderExchangeMast(scene) {
  const base = project({ x: scene.x, y: scene.facadeHeight + scene.crownHeight * 0.42, z: scene.z });
  const top = project({ x: scene.x, y: scene.height, z: scene.z });
  const ring = project({ x: scene.x, y: scene.facadeHeight + scene.crownHeight * 0.72, z: scene.z });
  return `
    <g class="form-mast">
      <path d="M ${format(base.x)} ${format(base.y)} L ${format(top.x)} ${format(top.y)}"></path>
      <ellipse cx="${format(ring.x)}" cy="${format(ring.y)}" rx="20" ry="7"></ellipse>
      <circle cx="${format(top.x)}" cy="${format(top.y)}" r="3"></circle>
    </g>`;
}

function renderGantry(scene, platformHeight) {
  const leftBottom = { x: scene.x - scene.width * 0.4, y: platformHeight, z: scene.z };
  const rightBottom = { x: scene.x + scene.width * 0.4, y: platformHeight, z: scene.z };
  const leftTop = { ...leftBottom, y: scene.height };
  const rightTop = { ...rightBottom, y: scene.height };
  const boom = { x: scene.x + scene.width * 0.58, y: scene.height, z: scene.z };
  return `
    <g class="form-gantry">
      <path d="${linePath(leftBottom, leftTop)}"></path>
      <path d="${linePath(rightBottom, rightTop)}"></path>
      <path d="${linePath(leftTop, boom)}"></path>
      <path d="${linePath(leftBottom, rightTop)}"></path>
      <path d="${linePath({ ...boom, y: scene.height }, { ...boom, y: platformHeight * 0.6 })}"></path>
    </g>`;
}

function project(point) {
  const x = point.x - state.camera.targetX;
  const z = point.z - state.camera.targetZ;
  const cosine = Math.cos(state.camera.yaw);
  const sine = Math.sin(state.camera.yaw);
  const rotatedX = x * cosine - z * sine;
  const rotatedZ = x * sine + z * cosine;
  const scale = WORLD_SCALE * state.camera.zoom;
  const screenY = rotatedZ * Math.sin(state.camera.pitch) - point.y * Math.cos(state.camera.pitch);
  const depth = rotatedZ * Math.cos(state.camera.pitch) + point.y * Math.sin(state.camera.pitch);
  return {
    x: VIEWBOX.centerX + rotatedX * scale,
    y: VIEWBOX.centerY + screenY * scale,
    depth,
  };
}

function boxCorners(x, z, width, depth, y) {
  return [
    { x: x - width / 2, y, z: z - depth / 2 },
    { x: x + width / 2, y, z: z - depth / 2 },
    { x: x + width / 2, y, z: z + depth / 2 },
    { x: x - width / 2, y, z: z + depth / 2 },
  ];
}

function circlePoints(radius) {
  const points = [];
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 48) {
    points.push({ x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius });
  }
  return points;
}

function pointPath(worldPoints, close = false) {
  return screenPointPath(worldPoints.map(project), close);
}

function screenPointPath(points, close = false) {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return `M ${format(first.x)} ${format(first.y)} ${rest.map((point) => `L ${format(point.x)} ${format(point.y)}`).join(" ")}${close ? " Z" : ""}`;
}

function linePath(from, to) {
  const start = project(from);
  const end = project(to);
  return `M ${format(start.x)} ${format(start.y)} L ${format(end.x)} ${format(end.y)}`;
}

function interpolate(from, to, amount) {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    depth: from.depth + (to.depth - from.depth) * amount,
  };
}

function rotateCamera(delta) {
  cancelCameraAnimation();
  state.camera.yaw += delta;
  renderWorld();
}

function zoomCamera(delta) {
  cancelCameraAnimation();
  state.camera.zoom = clamp(state.camera.zoom + delta, 0.58, 1.72);
  renderWorld();
}

function resetCamera() {
  animateCamera(DEFAULT_CAMERA);
}

function flyTo(subsystemId) {
  const scene = atlasScene(architectureSubsystem(subsystemId));
  animateCamera({
    yaw: state.camera.yaw,
    pitch: clamp(state.camera.pitch + 0.03, 0.34, 0.82),
    zoom: 1.34,
    targetX: scene.x,
    targetZ: scene.z,
  });
}

function animateCamera(target) {
  cancelCameraAnimation();
  if (motionPreference.matches) {
    Object.assign(state.camera, target);
    renderWorld();
    return;
  }
  const start = { ...state.camera };
  const startedAt = performance.now();
  const duration = 720;
  const tick = (now) => {
    const progress = clamp((now - startedAt) / duration, 0, 1);
    const eased = 1 - (1 - progress) ** 3;
    for (const key of Object.keys(target)) {
      state.camera[key] = start[key] + (target[key] - start[key]) * eased;
    }
    renderWorld();
    if (progress < 1) {
      state.cameraAnimation = requestAnimationFrame(tick);
    } else {
      state.cameraAnimation = 0;
    }
  };
  state.cameraAnimation = requestAnimationFrame(tick);
}

function cancelCameraAnimation() {
  if (state.cameraAnimation) cancelAnimationFrame(state.cameraAnimation);
  state.cameraAnimation = 0;
}

function updateCameraReadout() {
  const azimuth = ((state.camera.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const elevation = state.camera.pitch * 180 / Math.PI;
  elements.cameraReadout.textContent = `TURN ${Math.round(azimuth).toString().padStart(3, "0")}° · TILT ${Math.round(elevation)}° · ZOOM ${Math.round(state.camera.zoom * 100)}%`;
}

function worldPointerDown(event) {
  if (event.button !== 0) return;
  cancelCameraAnimation();
  const node = event.target.closest("[data-system]");
  state.drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    yaw: state.camera.yaw,
    pitch: state.camera.pitch,
    moved: false,
    hit: node
      ? {
          subsystemId: node.dataset.system,
          componentId: node.dataset.component ?? null,
        }
      : null,
  };
  elements.world.setPointerCapture(event.pointerId);
  elements.world.classList.add("is-dragging");
}

function worldPointerMove(event) {
  if (state.drag?.pointerId === event.pointerId) {
    const deltaX = event.clientX - state.drag.x;
    const deltaY = event.clientY - state.drag.y;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 5) state.drag.moved = true;
    state.camera.yaw = state.drag.yaw + deltaX * 0.006;
    state.camera.pitch = clamp(state.drag.pitch + deltaY * 0.004, 0.28, 0.88);
    hideHover();
    renderWorld();
    return;
  }
  const node = event.target.closest("[data-system]");
  if (!node) {
    hideHover();
    return;
  }
  const subsystem = architectureSubsystem(node.dataset.system);
  const component = node.dataset.component
    ? architectureComponent(subsystem.id, node.dataset.component)
    : null;
  elements.hover.hidden = false;
  elements.hover.innerHTML = `<span>${escapeHtml(subsystem.shortLabel)}</span><strong>${escapeHtml(component?.label ?? subsystem.label)}</strong><small>${component ? `${escapeHtml(component.plainLabel)} · CLICK THIS LIGHT TO LEARN MORE` : atlasDetail(subsystem.id).runtime}</small>`;
}

function worldPointerUp(event) {
  if (state.drag?.pointerId !== event.pointerId) return;
  const { moved, hit } = state.drag;
  const cancelled = event.type === "pointercancel";
  state.ignoreNextClick = !cancelled && (moved || Boolean(hit));
  state.drag = null;
  elements.world.classList.remove("is-dragging");
  if (elements.world.hasPointerCapture(event.pointerId)) elements.world.releasePointerCapture(event.pointerId);
  if (!cancelled && !moved && hit) {
    selectSubsystem(hit.subsystemId, hit.componentId, { reveal: true });
  }
  if (state.ignoreNextClick) {
    window.setTimeout(() => {
      state.ignoreNextClick = false;
    }, 0);
  }
}

function worldClicked(event) {
  if (state.ignoreNextClick) {
    state.ignoreNextClick = false;
    return;
  }
  const node = event.target.closest("[data-system]");
  if (!node) return;
  selectSubsystem(node.dataset.system, node.dataset.component ?? null, { reveal: true });
}

function worldDoubleClicked(event) {
  const node = event.target.closest("[data-system]");
  if (node) flyTo(node.dataset.system);
}

function worldWheeled(event) {
  event.preventDefault();
  zoomCamera(event.deltaY > 0 ? -0.08 : 0.08);
}

function worldKeyDown(event) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    rotateCamera(-0.12);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    rotateCamera(0.12);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.camera.pitch = clamp(state.camera.pitch - 0.08, 0.28, 0.88);
    renderWorld();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    state.camera.pitch = clamp(state.camera.pitch + 0.08, 0.28, 0.88);
    renderWorld();
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomCamera(0.1);
  } else if (event.key === "-") {
    event.preventDefault();
    zoomCamera(-0.1);
  } else if ((event.key === "Enter" || event.key === " ") && event.target.closest("[data-system]")) {
    event.preventDefault();
    const node = event.target.closest("[data-system]");
    selectSubsystem(node.dataset.system, node.dataset.component ?? null, { reveal: true });
  }
}

function documentKeyDown(event) {
  const typing = event.target.matches("input, textarea, select, [contenteditable='true']");
  if (event.key === "Escape" && elements.helpDialog.open) return;
  if (event.key === "Escape" && state.activePanel === "key") {
    event.preventDefault();
    closeWorkspace("key");
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    showWorkspace("systems");
    elements.search.focus();
    elements.search.select();
    return;
  }
  if (!typing && event.key === "/") {
    event.preventDefault();
    showWorkspace("systems");
    elements.search.focus();
    return;
  }
  if (event.key === "Escape" && state.searchQuery) {
    event.preventDefault();
    clearSearch();
    renderWorld();
    return;
  }
  if (event.key === "Escape" && !typing && state.activePanel) {
    event.preventDefault();
    closeWorkspace(state.activePanel);
  }
}

function hideHover() {
  elements.hover.hidden = true;
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    showToast(`COPIED · ${path}`);
  } catch {
    showToast(`COPY FAILED · ${path}`);
  }
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

function updateConcept() {
  const concept = ATLAS_CONCEPTS[state.conceptIndex];
  elements.concept.textContent = concept;
}

function syncConceptRotation() {
  if (state.conceptTimer) window.clearInterval(state.conceptTimer);
  state.conceptTimer = 0;
  if (motionPreference.matches) return;
  state.conceptTimer = window.setInterval(() => {
    state.conceptIndex = (state.conceptIndex + 1) % ATLAS_CONCEPTS.length;
    updateConcept();
  }, 3200);
}

function captureDataFocus(container, attributes) {
  const active = document.activeElement;
  if (!(active instanceof Element) || !container.contains(active)) return null;
  for (const attribute of attributes) {
    const target = active.closest(`[${attribute}]`);
    if (target && container.contains(target)) {
      return { attribute, value: target.getAttribute(attribute) };
    }
  }
  return null;
}

function restoreDataFocus(container, focus) {
  if (!focus) return;
  const candidate = [...container.querySelectorAll(`[${focus.attribute}]`)]
    .find((element) => element.getAttribute(focus.attribute) === focus.value);
  candidate?.focus({ preventScroll: true });
}

function focusInspectorHeading() {
  elements.inspector.querySelector("#inspector-title")?.focus();
}

function unique(values) {
  return [...new Set(values)];
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function format(value) {
  return value.toFixed(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
