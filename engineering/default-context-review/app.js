(function startContextReview() {
  "use strict";

  const snapshot = window.GSV_CONTEXT_REVIEW_SNAPSHOT;
  const model = window.GsvContextReviewModel;
  if (!snapshot || !model) {
    document.body.textContent = "The context review snapshot or model failed to load.";
    return;
  }

  const STORAGE_KEY = "gsv.default-context-review.v1";
  const groupById = new Map(snapshot.groups.map((group) => [group.id, group]));
  const blockById = new Map(snapshot.blocks.map((block) => [block.id, block]));
  let persisted = loadPersisted();
  let scenario = model.normalizeScenario(snapshot, persisted.scenario);
  const working = Object.fromEntries(snapshot.blocks.map((block) => [
    block.id,
    { ...model.resolvedBlockState(block, persisted.blocks) },
  ]));
  let selectedBlockId = snapshot.blocks[0].id;
  let activeTab = "prompt";
  let toastTimer = null;

  const elements = {
    sourceList: byId("source-list"),
    editorGroup: byId("editor-group"),
    editorTitle: byId("editor-title"),
    editorState: byId("editor-state"),
    editorRuntimePath: byId("editor-runtime-path"),
    editorNote: byId("editor-note"),
    editorIncluded: byId("editor-included"),
    blockEditor: byId("block-editor"),
    sourceRefs: byId("source-refs"),
    promptOutput: byId("prompt-output"),
    promptLegend: byId("prompt-legend"),
    firstUserMessage: byId("first-user-message"),
    notIncluded: byId("view-not-included"),
    trace: byId("view-trace"),
    toast: byId("toast"),
  };

  function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing #${id}`);
    return element;
  }

  function loadPersisted() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (value?.schemaVersion === snapshot.schemaVersion) {
        return {
          schemaVersion: snapshot.schemaVersion,
          scenario: value.scenario || {},
          blocks: value.blocks || {},
        };
      }
    } catch {
      // A corrupt local review should not prevent opening the source snapshot.
    }
    return { schemaVersion: snapshot.schemaVersion, scenario: {}, blocks: {} };
  }

  function writePersisted() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  }

  function savedState(block) {
    return model.resolvedBlockState(block, persisted.blocks);
  }

  function isUnsaved(block) {
    const saved = savedState(block);
    const current = working[block.id];
    return saved.template !== current.template || saved.included !== current.included;
  }

  function isChangedFromShipped(block) {
    const current = working[block.id];
    return current.template !== block.template || current.included !== block.defaultIncluded;
  }

  function hasUnsavedChanges() {
    return snapshot.blocks.some(isUnsaved) || scenarioIsUnsaved();
  }

  function scenarioIsUnsaved() {
    const saved = model.normalizeScenario(snapshot, persisted.scenario);
    return Object.keys(scenario).some((key) => scenario[key] !== saved[key]);
  }

  function renderAll(options = {}) {
    renderSources();
    if (options.editor !== false) renderEditor();
    renderPrompt();
    renderMetrics();
    renderScenarioSummary();
    renderNotIncluded();
    renderTrace();
  }

  function renderSources() {
    elements.sourceList.replaceChildren();
    for (const group of snapshot.groups) {
      const groupBlocks = snapshot.blocks.filter((block) => block.group === group.id);
      const heading = document.createElement("div");
      heading.className = "source-group-heading";
      const label = document.createElement("span");
      label.textContent = group.label;
      const count = document.createElement("small");
      count.textContent = String(groupBlocks.length);
      heading.append(label, count);
      elements.sourceList.append(heading);

      for (const block of groupBlocks) {
        const contribution = currentContribution(block);
        const button = document.createElement("button");
        button.type = "button";
        button.className = [
          "source-row",
          `source-${group.color}`,
          block.id === selectedBlockId ? "is-selected" : "",
          !working[block.id].included ? "is-excluded" : "",
        ].filter(Boolean).join(" ");
        button.dataset.blockId = block.id;
        button.setAttribute("aria-current", block.id === selectedBlockId ? "true" : "false");

        const marker = document.createElement("span");
        marker.className = "source-marker";
        const copy = document.createElement("span");
        copy.className = "source-row-copy";
        const name = document.createElement("strong");
        name.textContent = block.filename || "available_skills";
        const meta = document.createElement("span");
        meta.textContent = working[block.id].included
          ? `${formatNumber(contribution.length)} chars`
          : "excluded";
        copy.append(name, meta);
        const status = document.createElement("span");
        status.className = "row-status";
        status.textContent = isUnsaved(block) ? "unsaved" : isChangedFromShipped(block) ? "edited" : "";
        button.append(marker, copy, status);
        button.addEventListener("click", () => {
          selectedBlockId = block.id;
          renderSources();
          renderEditor();
        });
        elements.sourceList.append(button);
      }
    }
  }

  function currentContribution(block) {
    return model.renderTemplate(working[block.id].template, scenario).trim();
  }

  function renderEditor() {
    const block = blockById.get(selectedBlockId);
    const group = groupById.get(block.group);
    const current = working[block.id];
    elements.editorGroup.textContent = `${group.label} · ${block.kind.replace(/-/g, " ")}`;
    elements.editorTitle.textContent = block.filename || "available_skills";
    elements.editorRuntimePath.textContent = model.renderTemplate(block.runtimePath, scenario);
    elements.editorNote.textContent = block.note;
    elements.editorIncluded.checked = current.included;
    elements.blockEditor.value = current.template;
    elements.editorState.className = "state-badge";
    if (isUnsaved(block)) {
      elements.editorState.textContent = "Unsaved";
      elements.editorState.classList.add("state-unsaved");
    } else if (isChangedFromShipped(block)) {
      elements.editorState.textContent = "Saved draft";
      elements.editorState.classList.add("state-edited");
    } else {
      elements.editorState.textContent = "Shipped";
    }
    renderSourceRefs(block.sourceRefs, elements.sourceRefs);
  }

  function renderSourceRefs(refs, container) {
    container.replaceChildren();
    const label = document.createElement("span");
    label.textContent = "Source";
    container.append(label);
    for (const ref of refs) {
      const link = document.createElement("a");
      link.href = `../../${ref.path}#L${ref.line}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = `${ref.path}:${ref.line}`;
      link.title = ref.label;
      container.append(link);
    }
  }

  function renderPrompt() {
    const composition = model.composePrompt(snapshot, working, scenario);
    elements.promptOutput.replaceChildren();
    for (const piece of composition.pieces) {
      const span = document.createElement("span");
      span.textContent = piece.text;
      if (piece.kind === "wrapper") {
        span.className = "prompt-wrapper";
      } else {
        const group = groupById.get(piece.groupId);
        span.className = `prompt-source prompt-${group.color}`;
        span.dataset.blockId = piece.blockId;
        span.title = blockById.get(piece.blockId).filename || "available_skills";
      }
      elements.promptOutput.append(span);
    }
    elements.firstUserMessage.textContent = model.firstUserMessage(snapshot, scenario);

    elements.promptLegend.replaceChildren();
    for (const group of snapshot.groups) {
      const item = document.createElement("span");
      item.className = `legend-item legend-${group.color}`;
      item.textContent = group.shortLabel;
      elements.promptLegend.append(item);
    }
    const wrapper = document.createElement("span");
    wrapper.className = "legend-item legend-wrapper";
    wrapper.textContent = "Runtime wrapper";
    elements.promptLegend.append(wrapper);
  }

  function renderMetrics() {
    const composition = model.composePrompt(snapshot, working, scenario);
    const baseline = model.composePrompt(snapshot, {}, scenario);
    byId("metric-blocks").textContent = `${composition.activeBlocks} / ${snapshot.blocks.length}`;
    byId("metric-characters").textContent = formatNumber(composition.characters);
    byId("metric-bytes").textContent = formatNumber(composition.bytes);
    byId("metric-tokens").textContent = `≈ ${formatNumber(composition.estimatedTokens)}`;
    const delta = composition.characters - baseline.characters;
    byId("metric-delta").textContent = delta === 0 ? "0 chars" : `${delta > 0 ? "+" : "−"}${formatNumber(Math.abs(delta))} chars`;
    byId("metric-delta").className = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
    const largest = [...composition.contributions].sort((left, right) => right.text.length - left.text.length)[0];
    const largestBlock = largest ? blockById.get(largest.blockId) : null;
    byId("metric-largest").textContent = largestBlock
      ? `${largestBlock.filename || "available_skills"} · ${formatNumber(largest.text.length)}`
      : "—";
    byId("snapshot-chip").textContent = `source ${snapshot.sourceFingerprint}`;
    byId("source-count").textContent = String(snapshot.blocks.length);
  }

  function renderScenarioSummary() {
    byId("scenario-summary").textContent = `${scenario.userUsername} → ${scenario.agentUsername} · ${scenario.currentDate} · ${scenario.timezone}`;
  }

  function renderNotIncluded() {
    elements.notIncluded.replaceChildren();
    const intro = document.createElement("div");
    intro.className = "view-intro";
    intro.innerHTML = "<strong>These sources contribute zero characters to this first turn.</strong><span>Two are expected empty inputs; two expose a documentation/implementation mismatch worth resolving separately.</span>";
    elements.notIncluded.append(intro);
    for (const item of snapshot.notIncluded) {
      const card = document.createElement("article");
      card.className = "omission-card";
      const header = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = item.title;
      const status = document.createElement("span");
      status.textContent = item.status;
      header.append(title, status);
      const path = document.createElement("code");
      path.textContent = model.renderTemplate(item.pathTemplate, scenario);
      const explanation = document.createElement("p");
      explanation.textContent = item.explanation;
      const refs = document.createElement("div");
      refs.className = "source-refs compact";
      renderSourceRefs(item.sourceRefs, refs);
      card.append(header, path, explanation, refs);
      elements.notIncluded.append(card);
    }
  }

  function renderTrace() {
    elements.trace.replaceChildren();
    const list = document.createElement("ol");
    list.className = "trace-list";
    for (const item of snapshot.trace) {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = item.label;
      const detail = document.createElement("p");
      detail.textContent = item.detail;
      const link = document.createElement("a");
      link.href = `../../${item.sourceRef.path}#L${item.sourceRef.line}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = `${item.sourceRef.path}:${item.sourceRef.line}`;
      row.append(title, detail, link);
      list.append(row);
    }
    elements.trace.append(list);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("en-US").format(value);
  }

  function saveSelectedBlock() {
    const block = blockById.get(selectedBlockId);
    persisted.blocks[block.id] = { ...working[block.id] };
    writePersisted();
    renderAll();
    showToast(`Saved ${block.filename || "available_skills"} to this browser.`);
  }

  function saveScenario() {
    persisted.scenario = { ...scenario };
    writePersisted();
    renderAll();
    showToast("Saved scenario values to this browser.");
  }

  function restoreSelectedBlock() {
    const block = blockById.get(selectedBlockId);
    working[block.id] = model.defaultBlockState(block);
    renderAll();
    elements.blockEditor.focus();
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
  }

  async function copyPrompt() {
    const text = model.composePrompt(snapshot, working, scenario).text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    showToast("Copied the verbatim system prompt.");
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportReview() {
    const composition = model.composePrompt(snapshot, working, scenario);
    const payload = {
      kind: "gsv-default-context-review",
      schemaVersion: snapshot.schemaVersion,
      sourceFingerprint: snapshot.sourceFingerprint,
      exportedAt: new Date().toISOString(),
      scenario,
      blocks: working,
      systemPrompt: composition.text,
      firstUserMessage: model.firstUserMessage(snapshot, scenario),
    };
    download(
      `gsv-context-review-${scenario.currentDate}.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
      "application/json",
    );
    showToast("Exported the review draft and assembled prompt.");
  }

  async function importReview(file) {
    const payload = JSON.parse(await file.text());
    if (payload?.kind !== "gsv-default-context-review" || payload.schemaVersion !== snapshot.schemaVersion) {
      throw new Error("This is not a compatible GSV context review export.");
    }
    scenario = model.normalizeScenario(snapshot, payload.scenario);
    for (const block of snapshot.blocks) {
      const imported = payload.blocks?.[block.id];
      working[block.id] = {
        template: typeof imported?.template === "string" ? imported.template : block.template,
        included: typeof imported?.included === "boolean" ? imported.included : block.defaultIncluded,
      };
    }
    persisted = {
      schemaVersion: snapshot.schemaVersion,
      scenario: { ...scenario },
      blocks: Object.fromEntries(snapshot.blocks.map((block) => [block.id, { ...working[block.id] }])),
    };
    writePersisted();
    populateScenarioFields();
    renderAll();
    showToast("Imported and saved the review draft.");
  }

  function populateScenarioFields() {
    byId("scenario-user").value = scenario.userUsername;
    byId("scenario-agent").value = scenario.agentUsername;
    byId("scenario-date").value = scenario.currentDate;
    byId("scenario-timezone").value = scenario.timezone;
    byId("scenario-targets").value = scenario.targets;
    byId("scenario-mcp").value = scenario.mcpServers;
    byId("scenario-message").value = scenario.firstMessage;
  }

  elements.blockEditor.addEventListener("input", (event) => {
    working[selectedBlockId].template = event.currentTarget.value;
    renderAll({ editor: false });
    const block = blockById.get(selectedBlockId);
    elements.editorState.textContent = isUnsaved(block) ? "Unsaved" : isChangedFromShipped(block) ? "Saved draft" : "Shipped";
    elements.editorState.className = `state-badge ${isUnsaved(block) ? "state-unsaved" : isChangedFromShipped(block) ? "state-edited" : ""}`;
  });
  elements.editorIncluded.addEventListener("change", (event) => {
    working[selectedBlockId].included = event.currentTarget.checked;
    renderAll();
  });
  byId("save-block").addEventListener("click", saveSelectedBlock);
  byId("restore-block").addEventListener("click", restoreSelectedBlock);
  byId("save-scenario").addEventListener("click", saveScenario);
  byId("today-scenario").addEventListener("click", () => {
    scenario.currentDate = model.todayInTimezone(scenario.timezone);
    byId("scenario-date").value = scenario.currentDate;
    renderAll();
  });
  for (const input of document.querySelectorAll("[data-scenario]")) {
    input.addEventListener("input", (event) => {
      scenario[event.currentTarget.dataset.scenario] = event.currentTarget.value;
      scenario = model.normalizeScenario(snapshot, scenario);
      renderAll({ editor: false });
      elements.editorRuntimePath.textContent = model.renderTemplate(
        blockById.get(selectedBlockId).runtimePath,
        scenario,
      );
    });
  }
  elements.promptOutput.addEventListener("click", (event) => {
    const blockId = event.target.closest("[data-block-id]")?.dataset.blockId;
    if (!blockId || !blockById.has(blockId)) return;
    selectedBlockId = blockId;
    renderSources();
    renderEditor();
  });
  byId("copy-prompt").addEventListener("click", copyPrompt);
  byId("download-prompt").addEventListener("click", () => {
    download(
      `gsv-system-prompt-${scenario.currentDate}.txt`,
      `${model.composePrompt(snapshot, working, scenario).text}\n`,
      "text/plain",
    );
  });
  byId("export-review").addEventListener("click", exportReview);
  byId("import-review").addEventListener("click", () => byId("import-file").click());
  byId("import-file").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      await importReview(file);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      event.currentTarget.value = "";
    }
  });
  byId("reset-review").addEventListener("click", () => {
    if (!window.confirm("Reset every saved context-review draft in this browser?")) return;
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  });
  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      for (const candidate of document.querySelectorAll("[data-tab]")) {
        const selected = candidate.dataset.tab === activeTab;
        candidate.classList.toggle("is-active", selected);
        candidate.setAttribute("aria-selected", String(selected));
      }
      for (const view of document.querySelectorAll("[data-view]")) {
        view.classList.toggle("is-active", view.dataset.view === activeTab);
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveSelectedBlock();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  populateScenarioFields();
  renderAll();
})();
