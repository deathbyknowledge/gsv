import {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_FLOWS,
  ARCHITECTURE_SUBSYSTEMS,
  architectureComponent,
  architectureSubsystem,
  searchArchitecture,
} from "./architecture.mjs";
import {
  ATLAS_CONCEPTS,
  ATLAS_LENSES,
  ATLAS_TOUR_NOTES,
  ATLAS_ZONES,
  atlasDetail,
} from "./atlas-meta.mjs";

const VIEWBOX = { width: 1200, height: 820, centerX: 600, centerY: 492 };
const WORLD_SCALE = 2.28;
const DEFAULT_CAMERA = { yaw: -0.58, pitch: 0.56, zoom: 1, targetX: 0, targetZ: 0 };

const EDGE_COLORS = {
  request: "#62f4ff",
  control: "#d8ff52",
  data: "#ee8bff",
  contract: "#7faaff",
};

const SYSTEM_GROUPS = [
  {
    label: "INSTALLATION OWNERS",
    ids: ["gateway", "kernel", "process", "conversation", "native-target", "ripgit"],
  },
  {
    label: "CONTRACT + PROVIDER PLANE",
    ids: ["protocol", "sdk", "inference", "services", "deployment"],
  },
  {
    label: "PEERS + CAPABILITY EDGES",
    ids: ["web", "host", "adapters", "extension"],
  },
];

const elements = {
  atlas: document.querySelector("#atlas"),
  subsystemCount: document.querySelector("#subsystem-count"),
  componentCount: document.querySelector("#component-count"),
  routeCount: document.querySelector("#route-count"),
  lenses: document.querySelector("#lens-switcher"),
  revision: document.querySelector("#revision"),
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
const state = {
  selectedSubsystemId: "kernel",
  selectedComponentId: null,
  activePanel: window.matchMedia("(max-width: 760px)").matches ? null : "systems",
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
  if (restoreSelectionFromHash()) state.activePanel = "inspector";
  elements.subsystemCount.textContent = String(ARCHITECTURE_SUBSYSTEMS.length).padStart(2, "0");
  elements.componentCount.textContent = String(
    ARCHITECTURE_SUBSYSTEMS.reduce((total, subsystem) => total + subsystem.components.length, 0),
  ).padStart(2, "0");
  elements.routeCount.textContent = String(ARCHITECTURE_EDGES.length).padStart(2, "0");

  renderLensSwitcher();
  renderFlowOptions();
  renderWorkspace();
  renderAll();
  bindEvents();
  updateConcept();
  syncConceptRotation();
  motionPreference.addEventListener("change", syncConceptRotation);

  try {
    const response = await fetch("/api/meta");
    if (!response.ok) throw new Error(`Revision request failed: ${response.status}`);
    const meta = await response.json();
    state.sha = meta.sha;
    state.sourceBase = meta.sourceBase;
    elements.revision.textContent = meta.sha.toUpperCase();
    renderInspector();
  } catch {
    elements.revision.textContent = "LOCAL SOURCE";
  }
}

function bindEvents() {
  elements.workspaceSwitcher.addEventListener("click", (event) => {
    const button = event.target.closest("[data-workspace-panel]");
    if (!button) return;
    const panel = button.dataset.workspacePanel;
    showWorkspace(state.activePanel === panel ? null : panel);
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
    if (button) selectSubsystem(button.dataset.system, null, { focusInspector: true });
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
    selectSubsystem(result.subsystemId, result.componentId ?? null, { fly: true, focusInspector: true });
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
  elements.lenses.replaceChildren(...ATLAS_LENSES.map((lens, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.lens = lens.id;
    button.innerHTML = `<span>0${index + 1}</span>${escapeHtml(lens.label)}`;
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
  elements.lensCode.textContent = `${lens.label} TOPOLOGY`;
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

function renderSystemList() {
  const focus = captureDataFocus(elements.systems, ["data-system"]);
  const matches = matchedSubsystems();
  const sections = SYSTEM_GROUPS.map((group) => {
    const rows = group.ids.map((id) => {
      const subsystem = architectureSubsystem(id);
      const detail = atlasDetail(id);
      const classes = [
        "system-row",
        `tone-${subsystem.category}`,
        id === state.selectedSubsystemId ? "is-selected" : "",
        matches && !matches.has(id) ? "is-muted" : "",
      ].filter(Boolean).join(" ");
      return `
        <button class="${classes}" type="button" data-system="${id}">
          <i></i>
          <span>
            <strong>${escapeHtml(subsystem.shortLabel)}</strong>
            <small>${escapeHtml(detail.scope)}</small>
          </span>
          <em>${String(subsystem.components.length).padStart(2, "0")}</em>
        </button>`;
    }).join("");
    return `<section><h2>${escapeHtml(group.label)}</h2>${rows}</section>`;
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
    const text = [
      detail.scope,
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
  return augmented.slice(0, 24);
}

function renderSearchResults() {
  if (!state.searchQuery) {
    elements.searchResults.hidden = true;
    elements.searchResults.replaceChildren();
    return;
  }
  elements.searchResults.hidden = false;
  if (state.searchResults.length === 0) {
    elements.searchResults.innerHTML = "<p>NO COORDINATES FOUND</p>";
    return;
  }
  elements.searchResults.innerHTML = state.searchResults.map((result, index) => {
    const subsystem = architectureSubsystem(result.subsystemId);
    return `
      <button type="button" data-result-index="${index}">
        <span>${escapeHtml(subsystem.shortLabel)}</span>
        <strong>${escapeHtml(result.label)}</strong>
        <code>${escapeHtml(result.path ?? subsystem.sourceRoot)}</code>
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
  const systemNumber = ARCHITECTURE_SUBSYSTEMS.findIndex((candidate) => candidate.id === subsystem.id) + 1;
  const sourcePaths = component
    ? component.paths
    : [subsystem.sourceRoot, ...subsystem.components.map((candidate) => candidate.paths[0])];
  const relatedEdges = ARCHITECTURE_EDGES.filter(
    (edge) => edge.from === subsystem.id || edge.to === subsystem.id,
  );
  const componentProfile = component ? `
    <section class="component-profile">
      <div class="section-label"><span>SELECTED COMPONENT</span><i></i></div>
      <h3>${escapeHtml(component.label)}</h3>
      <p>${escapeHtml(component.summary)}</p>
      <ol>${component.mechanics.map((mechanic) => `<li>${escapeHtml(mechanic)}</li>`).join("")}</ol>
    </section>` : "";
  const overviewContent = `
    <p class="system-summary">${escapeHtml(subsystem.summary)}</p>

    <section class="evidence-grid">
      ${factCard("RUNTIME", detail.runtime, "runtime")}
      ${factCard("OWNER", detail.owner, "ownership")}
      ${factCard("PERSISTENCE", detail.persistence, "durability")}
      ${factCard("ADMISSION GATE", detail.admission, "security")}
      ${factCard("COMPLETION + CLEANUP", detail.completion, "ownership")}
    </section>

    <section class="invariant-panel">
      <div class="section-label"><span>BOUNDARY</span><i></i></div>
      <p>${escapeHtml(subsystem.boundary)}</p>
      <div class="invariant-callout">
        <strong>INVARIANT</strong>
        <p>${escapeHtml(subsystem.invariant)}</p>
      </div>
    </section>

    <section class="security-facts">
      <div class="section-label"><span>SECURITY FACTS</span><i></i></div>
      <ul>${detail.security.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>
    </section>`;
  const componentsContent = `
    ${componentProfile}
    <section class="component-index">
      <div class="section-label"><span>COMPONENT DECKS / ${subsystem.components.length}</span><i></i></div>
      ${subsystem.components.map((candidate, index) => `
        <button type="button" data-component="${candidate.id}" class="${candidate.id === component?.id ? "is-selected" : ""}">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>${escapeHtml(candidate.label)}</strong>
            <p>${escapeHtml(candidate.summary)}</p>
            <code>${escapeHtml(candidate.paths[0])}</code>
          </div>
        </button>`).join("")}
    </section>`;
  const sourceContent = `
    <section class="source-evidence">
      <div class="section-label"><span>PRIMARY SOURCE</span><i></i></div>
      ${unique(sourcePaths).map((path) => sourceRow(path, "source")).join("")}
      <details>
        <summary>ARCHITECTURE NOTES / ${detail.docs.length}</summary>
        ${detail.docs.map((path) => sourceRow(path, "document")).join("")}
      </details>
      <details>
        <summary>EXECUTABLE EVIDENCE / ${detail.tests.length}</summary>
        ${detail.tests.map((path) => sourceRow(path, "test")).join("")}
      </details>
    </section>`;
  const routesContent = `
    <section class="route-index">
      <div class="section-label"><span>CONNECTED ROUTES / ${relatedEdges.length}</span><i></i></div>
      ${relatedEdges.map((edge) => {
        const otherId = edge.from === subsystem.id ? edge.to : edge.from;
        const direction = edge.from === subsystem.id ? "OUT" : "IN";
        return `
          <button type="button" data-related-system="${otherId}">
            <span class="route-kind is-${edge.kind}">${escapeHtml(edge.kind)}</span>
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

  elements.inspector.dataset.category = subsystem.category;
  elements.inspector.innerHTML = `
    <header class="inspector-header">
      <div class="system-serial">SYS-${String(systemNumber).padStart(2, "0")}</div>
      <button class="panel-close" type="button" data-close-panel="inspector" aria-label="Close details">×</button>
      <p>${escapeHtml(subsystem.category.toUpperCase())} / ${escapeHtml(detail.scope.toUpperCase())}</p>
      <h2 id="inspector-title" tabindex="-1">${escapeHtml(subsystem.label)}</h2>
      <span>${escapeHtml(subsystem.sourceRoot)}</span>
      <button class="inspector-fly" type="button" data-fly-to>FLY TO LANDMARK ↗</button>
    </header>

    <div class="inspector-scroll">
      <nav class="inspector-tabs" aria-label="Choose subsystem detail view">
        ${[
          ["overview", "OVERVIEW"],
          ["components", `COMPONENTS ${subsystem.components.length}`],
          ["source", "SOURCE"],
          ["routes", `ROUTES ${relatedEdges.length}`],
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
      <button type="button" data-copy-path="${escapeAttribute(path)}" aria-label="Copy ${escapeAttribute(path)}">COPY</button>
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
  elements.flowPlay.setAttribute("aria-label", state.playing ? "Pause guided trace" : "Play guided trace");
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
    ? `<strong>THESIS</strong> ${escapeHtml(notes.thesis)} <em>${escapeHtml(notes.warning)}</em>`
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

  const towers = ARCHITECTURE_SUBSYSTEMS.map((subsystem) => ({
    subsystem,
    detail: atlasDetail(subsystem.id),
    depth: project({
      x: atlasDetail(subsystem.id).scene.x,
      y: atlasDetail(subsystem.id).scene.height / 2,
      z: atlasDetail(subsystem.id).scene.z,
    }).depth,
  })).sort((left, right) => left.depth - right.depth);

  const ground = renderGround();
  const parcels = state.lens === "ownership" ? renderOwnershipParcels() : "";
  const foundations = state.lens === "durability"
    ? towers.map(({ subsystem, detail }) => renderFoundation(subsystem, detail)).join("")
    : "";
  const routes = renderRoutes();
  const traceRoutes = renderTraceRoutes(flow);
  const nodes = towers.map(({ subsystem, detail }) => {
    const flowIndex = flowStates.get(subsystem.id);
    return renderTower(subsystem, detail, {
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

function renderGround() {
  const grid = [];
  const gridExtent = 260;
  const outerRadius = ATLAS_ZONES.find((zone) => zone.id === "outer")?.radius ?? 233;
  const boundaryRadius = ATLAS_ZONES.find((zone) => zone.id === "boundary")?.radius ?? 164;
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
  return `
    <path d="${pointPath(circlePoints(outerRadius), true)}" class="terrain-field"></path>
    <g class="terrain-grid">${grid.join("")}</g>
    <g class="terrain-zones">${zones}</g>
    <g class="installation-gate">
      <path d="M ${format(gateLeft.x)} ${format(gateLeft.y)} L ${format(gateLeftTop.x)} ${format(gateLeftTop.y)}"></path>
      <path d="M ${format(gateRight.x)} ${format(gateRight.y)} L ${format(gateRightTop.x)} ${format(gateRightTop.y)}"></path>
      <path d="M ${format(gateLeftTop.x)} ${format(gateLeftTop.y)} Q ${format((gateLeftTop.x + gateRightTop.x) / 2)} ${format(Math.min(gateLeftTop.y, gateRightTop.y) - 26)} ${format(gateRightTop.x)} ${format(gateRightTop.y)}"></path>
      <text x="${format((gateLeftTop.x + gateRightTop.x) / 2)}" y="${format(Math.min(gateLeftTop.y, gateRightTop.y) - 32)}">TRUSTED ROUTE GATE</text>
    </g>`;
}

function renderOwnershipParcels() {
  return ARCHITECTURE_SUBSYSTEMS.map((subsystem) => {
    const scene = atlasDetail(subsystem.id).scene;
    const padding = 8;
    const points = [
      { x: scene.x - scene.width / 2 - padding, y: 0.3, z: scene.z - scene.depth / 2 - padding },
      { x: scene.x + scene.width / 2 + padding, y: 0.3, z: scene.z - scene.depth / 2 - padding },
      { x: scene.x + scene.width / 2 + padding, y: 0.3, z: scene.z + scene.depth / 2 + padding },
      { x: scene.x - scene.width / 2 - padding, y: 0.3, z: scene.z + scene.depth / 2 + padding },
    ];
    return `<path d="${pointPath(points, true)}" class="ownership-parcel parcel-${subsystem.category} ${subsystem.id === state.selectedSubsystemId ? "is-selected" : ""}"></path>`;
  }).join("");
}

function renderFoundation(subsystem, detail) {
  const { x, z, width, depth } = detail.scene;
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
      <text x="${format(label.x)}" y="${format(label.y + 14)}">${escapeHtml(persistenceCode(subsystem.id))}</text>
    </g>`;
}

function persistenceCode(id) {
  const codes = {
    gateway: "ROUTE",
    kernel: "K-SQL",
    process: "P-SQL",
    conversation: "C-SQL / R2",
    protocol: "STATELESS",
    "native-target": "R2 / GIT",
    inference: "STREAM",
    sdk: "EPHEMERAL",
    services: "OPERATOR",
    web: "CLIENT CACHE",
    host: "LOCAL",
    adapters: "DO LEDGER",
    extension: "IDB",
    ripgit: "GIT OBJECTS",
    deployment: "MANIFESTS",
  };
  return codes[id] ?? "STATE";
}

function renderRoutes() {
  return ARCHITECTURE_EDGES.map((edge) => {
    const from = atlasDetail(edge.from).scene;
    const to = atlasDetail(edge.to).scene;
    const selected = edge.from === state.selectedSubsystemId || edge.to === state.selectedSubsystemId;
    const emphasized = state.lens === "security"
      ? edge.kind === "control" || edge.kind === "contract"
      : state.lens === "durability"
        ? edge.kind === "data"
        : state.lens === "ownership"
          ? selected
          : true;
    const path = routePath(from, to, 26);
    return `
      <path d="${path}" class="world-route route-${edge.kind}${selected ? " is-selected" : ""}${emphasized ? " is-emphasized" : ""}" stroke="${EDGE_COLORS[edge.kind]}" marker-end="url(#route-arrow)">
        <title>${escapeHtml(`${architectureSubsystem(edge.from).shortLabel} → ${architectureSubsystem(edge.to).shortLabel}: ${edge.label}`)}</title>
      </path>`;
  }).join("");
}

function renderTraceRoutes(flow) {
  const routes = [];
  for (let index = 1; index < flow.steps.length; index += 1) {
    const previous = flow.steps[index - 1];
    const current = flow.steps[index];
    if (previous.subsystemId === current.subsystemId) continue;
    const from = atlasDetail(previous.subsystemId).scene;
    const to = atlasDetail(current.subsystemId).scene;
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

function renderTower(subsystem, detail, flags) {
  const { x, z, width, depth, height } = detail.scene;
  const baseWorld = boxCorners(x, z, width, depth, 0);
  const topWorld = boxCorners(x, z, width, depth, height);
  const base = baseWorld.map(project);
  const top = topWorld.map(project);
  const faces = [0, 1, 2, 3].map((index) => {
    const next = (index + 1) % 4;
    const points = [base[index], base[next], top[next], top[index]];
    return {
      index,
      next,
      points,
      depth: points.reduce((total, point) => total + point.depth, 0) / points.length,
    };
  }).sort((left, right) => left.depth - right.depth);
  const nearFace = faces[faces.length - 1];
  const topCenter = project({ x, y: height, z });
  const groundCenter = project({ x, y: 0, z });
  const labelWidth = Math.max(86, subsystem.shortLabel.length * 7.2 + 34);
  const labelY = Math.min(...top.map((point) => point.y)) - 40;
  const classes = [
    "world-node",
    `node-${subsystem.category}`,
    flags.selected ? "is-selected" : "",
    flags.connected ? "is-connected" : "",
    !flags.matched ? "is-search-muted" : "",
    `trace-${flags.traceState}`,
  ].filter(Boolean).join(" ");
  const faceMarkup = faces.map((face, index) => `
    <path d="${screenPointPath(face.points, true)}" class="tower-face face-${index}"></path>`).join("");
  const componentDecks = renderComponentDecks(subsystem, nearFace, base, top);
  const selectedBeam = flags.selected ? `
    <ellipse cx="${format(groundCenter.x)}" cy="${format(groundCenter.y)}" rx="46" ry="22" class="selection-flare"></ellipse>
    <path d="M ${format(groundCenter.x)} ${format(groundCenter.y)} L ${format(topCenter.x)} ${format(topCenter.y - 92)}" class="selection-beam"></path>
    <circle cx="${format(topCenter.x)}" cy="${format(topCenter.y - 92)}" r="5" class="selection-orb"></circle>` : "";
  const securityBadge = state.lens === "security" ? `
    <g class="security-badge" transform="translate(${format(topCenter.x + 24)} ${format(labelY + 28)})">
      <circle r="10"></circle><text y="4">${securityCode(subsystem.id)}</text>
    </g>` : "";

  return `
    <g class="${classes}" data-system="${subsystem.id}" role="button" tabindex="0" aria-label="${escapeAttribute(subsystem.label)}; ${subsystem.components.length} components">
      ${selectedBeam}
      <g class="tower-geometry">
        ${faceMarkup}
        <path d="${screenPointPath(top, true)}" class="tower-top"></path>
        ${componentDecks}
        <path d="${screenPointPath(base, true)}" class="tower-footprint"></path>
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

function renderComponentDecks(subsystem, face, base, top) {
  const count = subsystem.components.length;
  const decks = [];
  for (let index = 0; index < count; index += 1) {
    const low = index / count;
    const high = (index + 1) / count;
    const leftLow = interpolate(base[face.index], top[face.index], low);
    const rightLow = interpolate(base[face.next], top[face.next], low);
    const leftHigh = interpolate(base[face.index], top[face.index], high);
    const rightHigh = interpolate(base[face.next], top[face.next], high);
    const component = subsystem.components[index];
    const selected = component.id === state.selectedComponentId && subsystem.id === state.selectedSubsystemId;
    decks.push(`
      <path d="${screenPointPath([leftLow, rightLow, rightHigh, leftHigh], true)}" class="component-deck${selected ? " is-selected" : ""}" data-system="${subsystem.id}" data-component="${component.id}">
        <title>${escapeHtml(component.label)}</title>
      </path>`);
  }
  return decks.join("");
}

function securityCode(id) {
  const codes = {
    gateway: "G",
    kernel: "K",
    process: "P",
    conversation: "C",
    protocol: "Φ",
    "native-target": "T",
    inference: "AI",
    sdk: "S",
    services: "M",
    web: "U",
    host: "H",
    adapters: "A",
    extension: "B",
    ripgit: "R",
    deployment: "D",
  };
  return codes[id] ?? "•";
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
  const scene = atlasDetail(subsystemId).scene;
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
  elements.cameraReadout.textContent = `AZ ${Math.round(azimuth).toString().padStart(3, "0")}° · EL ${Math.round(elevation)}° · ${Math.round(state.camera.zoom * 100)}%`;
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
  elements.hover.innerHTML = `<span>${escapeHtml(subsystem.shortLabel)}</span><strong>${escapeHtml(component?.label ?? subsystem.label)}</strong><small>${component ? "COMPONENT DECK" : atlasDetail(subsystem.id).runtime}</small>`;
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
    selectSubsystem(hit.subsystemId, hit.componentId);
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
  selectSubsystem(node.dataset.system, node.dataset.component ?? null);
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
    selectSubsystem(node.dataset.system, node.dataset.component ?? null);
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
  const [left, right] = concept.split("≠").map((part) => part.trim());
  elements.concept.innerHTML = `<strong>${escapeHtml(left)}</strong><span>≠</span><strong>${escapeHtml(right)}</strong>`;
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
