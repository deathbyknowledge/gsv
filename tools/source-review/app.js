import DOMPurify from "/sanitize.js";

const fileGroups = {
  prompts: new Map([
    ["system", "System"],
    ["ship", "Ship"],
    ["crew", "Crew"],
    ["user", "Owner"],
    ["tasks", "Task prompts"],
    ["onboarding", "Onboarding"],
  ]),
  // The 2.0 draft keeps 1.0's directory names so it renders with the same assembler.
  context: new Map([
    ["", "Notes"],
    ["system", "Runtime (1.0 system)"],
    ["ship", "Ship"],
    ["crew", "Crew"],
    ["user", "Owner"],
    ["moved", "Moved out of standing context"],
  ]),
};
const previewViews = {
  prompts: [["category", "Entry"], ["sections", "Sections"], ["exact", "Exact text"], ["catalog", "All sources"]],
  context: [["diff", "Diff vs 1.0"], ["sections", "Sections"], ["exact", "Exact text"]],
};

const elements = {
  tabs: document.querySelector("#workspace-tabs"),
  root: document.querySelector("#root-path"),
  refresh: document.querySelector("#refresh"),
  search: document.querySelector("#file-search"),
  files: document.querySelector("#file-list"),
  kind: document.querySelector("#review-kind"),
  title: document.querySelector("#review-title"),
  stats: document.querySelector("#review-stats"),
  note: document.querySelector("#review-note"),
  preview: document.querySelector("#preview"),
  promptControls: document.querySelector("#prompt-controls"),
  account: document.querySelector("#prompt-account"),
  view: document.querySelector("#prompt-view"),
  sourcePath: document.querySelector("#source-path"),
  source: document.querySelector("#source"),
  save: document.querySelector("#save"),
  saveState: document.querySelector("#save-state"),
  resetBaseline: document.querySelector("#reset-baseline"),
  diffPanel: document.querySelector("#diff-panel"),
  diffLabel: document.querySelector("#diff-label"),
  diff: document.querySelector("#diff"),
  errorDialog: document.querySelector("#error-dialog"),
  errorMessage: document.querySelector("#error-message"),
};

const state = {
  config: null,
  workspace: null,
  files: [],
  selectedPath: null,
  sourceText: "",
  sourceHash: null,
  dirty: false,
  renderTimer: null,
  previewVersion: 0,
  selectionVersion: 0,
  saving: false,
  promptSources: new Map(),
  baselineText: null,
};

await initialize().catch(showError);

async function initialize() {
  state.config = await requestJson("/api/config");
  renderTabs();
  await selectWorkspace(state.config.initialWorkspace);

  elements.refresh.addEventListener("click", () => void refresh().catch(showError));
  elements.search.addEventListener("input", renderFileList);
  elements.source.addEventListener("input", sourceChanged);
  elements.save.addEventListener("click", () => void saveSource());
  elements.resetBaseline.addEventListener("click", resetToBaseline);
  elements.account.addEventListener("change", () => void renderPreview().catch(showError));
  elements.view.addEventListener("change", () => void renderPreview().catch(showError));
  elements.preview.addEventListener("click", previewClicked);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveSource();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) {
      event.preventDefault();
    }
  });
}

function renderTabs() {
  elements.tabs.replaceChildren(...state.config.workspaces.map((workspace) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = workspace.label;
    button.classList.toggle("is-active", workspace.id === state.workspace);
    button.addEventListener("click", () => void selectWorkspace(workspace.id).catch(showError));
    return button;
  }));
}

async function selectWorkspace(workspace) {
  if (workspace === state.workspace) return;
  if (!confirmDiscard()) return;
  state.workspace = workspace;
  state.previewVersion++;
  state.selectionVersion++;
  clearTimeout(state.renderTimer);
  state.selectedPath = null;
  state.sourceText = "";
  state.sourceHash = null;
  elements.source.value = "";
  elements.source.disabled = true;
  setDirty(false);
  elements.promptControls.hidden = !previewViews[workspace];
  if (previewViews[workspace]) {
    elements.view.replaceChildren(...previewViews[workspace].map(([value, label]) => new Option(label, value)));
  }
  elements.diffLabel.textContent = workspace === "context" ? "DIFF VS 1.0" : "GIT DIFF";
  elements.diffPanel.open = workspace === "context";
  elements.resetBaseline.hidden = true;
  renderTabs();
  await refresh();
}

async function refresh() {
  if (state.dirty && !confirmDiscard()) return;
  const version = ++state.selectionVersion;
  elements.source.disabled = true;
  elements.save.disabled = true;
  const data = await requestJson(`/api/files?workspace=${encodeURIComponent(state.workspace)}`).catch((error) => {
    if (version === state.selectionVersion) {
      elements.source.disabled = !state.selectedPath;
      setDirty(state.dirty);
    }
    throw error;
  });
  if (version !== state.selectionVersion) return;
  state.files = data.files;
  elements.root.textContent = data.root;
  elements.root.title = data.root;
  renderFileList();

  const currentExists = state.files.some((file) => file.path === state.selectedPath);
  const preferredPath = { manual: "index.md", prompts: "system/context.d/01-gsv.md", context: "NOTES.md" }[state.workspace];
  const preferred = state.files.find((file) => file.path === preferredPath)?.path;
  if (!currentExists) {
    await selectFile(preferred ?? state.files[0]?.path ?? null, true);
  } else if (state.selectedPath) {
    await selectFile(state.selectedPath, true);
  }
}

function renderFileList() {
  const query = elements.search.value.trim().toLowerCase();
  const files = state.files.filter((file) => !query || file.path.toLowerCase().includes(query));
  const categories = fileGroups[state.workspace];
  const groupOf = (path) => path.includes("/") ? path.split("/")[0] : "";
  const groups = categories
    ? [...new Set([...categories.keys(), ...files.map((file) => groupOf(file.path))])]
      .map((category) => [category, files.filter((file) => groupOf(file.path) === category)])
    : [[null, files]];
  const rows = [];
  for (const [category, entries] of groups) {
    if (entries.length === 0) continue;
    if (category !== null) {
      const heading = document.createElement("h3");
      heading.className = "file-group";
      heading.textContent = categories.get(category) ?? category;
      rows.push(heading);
    }
    for (const file of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `file-row${file.path === state.selectedPath ? " is-active" : ""}`;
      button.textContent = category ? file.path.slice(category.length + 1).replace(/^context\.d\//, "") : file.path;
      button.setAttribute("aria-label", file.path);
      button.title = `${file.path} · ${file.bytes.toLocaleString()} bytes`;
      button.addEventListener("click", () => void selectFile(file.path).catch(showError));
      rows.push(button);
    }
  }
  elements.files.replaceChildren(...rows);
}

async function selectFile(path, force = false) {
  if (!path || (!force && path === state.selectedPath)) return;
  if (!force && !confirmDiscard()) return;
  const version = ++state.selectionVersion;
  elements.source.disabled = true;
  elements.save.disabled = true;
  clearTimeout(state.renderTimer);
  state.previewVersion++;
  const data = await requestJson(
    `/api/file?workspace=${encodeURIComponent(state.workspace)}&path=${encodeURIComponent(path)}`,
  ).catch((error) => {
    if (version === state.selectionVersion) {
      elements.source.disabled = !state.selectedPath;
      setDirty(state.dirty);
    }
    throw error;
  });
  if (version !== state.selectionVersion) return;
  state.selectedPath = path;
  state.sourceText = data.content;
  state.sourceHash = data.hash;
  elements.source.value = data.content;
  elements.source.disabled = false;
  elements.sourcePath.textContent = path;
  setDirty(false);
  renderFileList();
  await refreshDiff();
  if (version !== state.selectionVersion) return;
  if (state.workspace === "prompts") {
    const scope = state.promptSources.get(path)?.scope;
    if (scope === "ship") elements.account.value = "ship";
    if (scope === "crew") elements.account.value = "crew";
    if (path.startsWith("tasks/")) elements.view.value = "category";
  }
  if (state.workspace === "context") {
    if (path.startsWith("ship/")) elements.account.value = "ship";
    if (path.startsWith("crew/")) elements.account.value = "crew";
  }
  await renderPreview();
}

function renderPreview() {
  if (state.workspace === "prompts") return renderPromptPreview();
  if (state.workspace === "context") return renderContextPreview();
  return renderManualPreview(elements.source.value);
}

function sourceChanged() {
  setDirty(elements.source.value !== state.sourceText);
  state.previewVersion++;
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    void renderPreview().catch(showError);
    if (state.workspace === "context") void refreshDiff().catch(showError);
  }, 200);
}

function resetToBaseline() {
  if (state.baselineText === null) return;
  elements.source.value = state.baselineText;
  sourceChanged();
}

function setDirty(dirty) {
  state.dirty = dirty;
  elements.save.disabled = state.saving || elements.source.disabled || !dirty || !state.selectedPath;
  elements.saveState.textContent = dirty ? "UNSAVED" : state.selectedPath ? "SAVED" : "";
  elements.saveState.className = `save-state${dirty ? " is-dirty" : ""}`;
}

async function saveSource() {
  if (!state.dirty || !state.selectedPath || state.saving || elements.source.disabled) return;
  state.saving = true;
  const submitted = {
    workspace: state.workspace, path: state.selectedPath,
    content: elements.source.value, expectedHash: state.sourceHash,
  };
  elements.save.disabled = true;
  elements.saveState.textContent = "SAVING";
  try {
    const data = await requestJson("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submitted),
    });
    state.sourceText = submitted.content;
    state.sourceHash = data.hash;
    setDirty(elements.source.value !== state.sourceText);
  } catch (error) {
    elements.saveState.textContent = "SAVE FAILED";
    elements.saveState.className = "save-state is-error";
    showError(error);
    return;
  } finally {
    state.saving = false;
    elements.save.disabled = !state.dirty || !state.selectedPath;
  }
  void refreshDiff().catch(showError);
  if (state.workspace !== "manual") void renderPreview().catch(showError);
}

async function renderPromptPreview() {
  const version = ++state.previewVersion;
  const account = elements.account.value;
  const view = elements.view.value;
  const body = { account };
  if (state.dirty) body.draft = { path: state.selectedPath, content: elements.source.value };
  const data = await requestJson("/api/prompt-preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (version !== state.previewVersion) return;
  state.promptSources = new Map(data.catalog.map((source) => [source.path, source]));
  const sourceView = view === "catalog" || view === "category";
  const blocks = view === "category" ? data.catalog.filter((source) => source.path === state.selectedPath)
    : view === "catalog" ? data.catalog : data.sections;
  elements.account.disabled = sourceView;
  elements.kind.textContent = "REPOSITORY DEFAULTS";
  elements.title.textContent = view === "category" ? state.selectedPath
    : view === "catalog" ? "All prompt sources" : `${account === "ship" ? "Ship" : "Crew"} · assembled prompt`;
  elements.note.textContent = "Sample account and runtime. Saved edits change this worktree; space overrides stay intact.";
  const bytes = new TextEncoder().encode(sourceView ? blocks.map((source) => source.text).join("") : data.prompt).length;
  elements.stats.textContent = `${sourceView ? `${blocks.length} SOURCES` : `${data.sections.length} SECTIONS`} · ${formatCount(bytes)} BYTES`;
  const scrollTop = elements.preview.scrollTop;
  if (view === "exact") {
    const pre = document.createElement("pre");
    pre.className = "exact-prompt";
    pre.textContent = data.prompt;
    elements.preview.replaceChildren(pre);
  } else {
    elements.preview.replaceChildren(...sectionBlocks(blocks));
  }
  elements.preview.scrollTop = scrollTop;
}

// Draft standing files rendered with 1.0's assembler, next to the repository prompt they replace.
async function renderContextPreview() {
  const version = ++state.previewVersion;
  const account = elements.account.value;
  const view = elements.view.value;
  const body = { account };
  if (state.dirty) body.draft = { path: state.selectedPath, content: elements.source.value };
  const data = await requestJson("/api/context-preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (version !== state.previewVersion) return;
  elements.account.disabled = false;
  const name = account === "ship" ? "Ship" : "Crew";
  elements.kind.textContent = "2.0 DRAFT · RENDERED WITH THE 1.0 ASSEMBLER";
  elements.title.textContent = view === "diff" ? `${name} · prompt diff vs 1.0` : `${name} · draft prompt`;
  elements.note.textContent = "Sample account and runtime. Ship placeholders get sample values. "
    + `All standing files: 1.0 ${formatSize(data.baseline.standingBytes)} → draft ${formatSize(data.draft.standingBytes)}. `
    + "Files under moved/ and NOTES.md are not in the prompt.";
  elements.stats.textContent = `${name.toUpperCase()} PROMPT · 1.0 ${formatSize(data.baseline.bytes)} → DRAFT ${formatSize(data.draft.bytes)} · `
    + `${formatChange(data.baseline.bytes, data.draft.bytes)} · +${data.diff.added} −${data.diff.removed} LINES`;
  const scrollTop = elements.preview.scrollTop;
  if (view === "diff") {
    elements.preview.replaceChildren(diffView(data.diff.hunks, "The draft renders the same prompt as 1.0."));
  } else if (view === "exact") {
    const pre = document.createElement("pre");
    pre.className = "exact-prompt";
    pre.textContent = data.draft.prompt;
    elements.preview.replaceChildren(pre);
  } else {
    elements.preview.replaceChildren(...sectionBlocks(data.draft.sections));
  }
  elements.preview.scrollTop = scrollTop;
}

function sectionBlocks(blocks) {
  return blocks.map((block) => {
    const section = document.createElement("section");
    const root = block.contextRoot?.key;
    const paths = block.path ? [block.path] : block.paths;
    section.className = `prompt-block is-${root === "system" || block.scope === "shared" ? "system" : "personal"}`;
    section.classList.toggle("is-selected", paths.includes(state.selectedPath));
    const header = document.createElement("header");
    const names = document.createElement("div");
    names.className = "source-links";
    if (paths.length > 0) {
      for (const path of paths) {
        const name = document.createElement("button");
        name.type = "button";
        name.dataset.sourcePath = path;
        name.textContent = path;
        names.append(name);
      }
    } else {
      const name = document.createElement("strong");
      name.textContent = "Available skills · generated";
      names.append(name);
    }
    const meta = document.createElement("small");
    meta.textContent = `${block.scope ? `${block.scope.toUpperCase()} · ` : ""}${formatCount(new TextEncoder().encode(block.text).length)} B`;
    header.append(names, meta);
    const article = document.createElement(paths.length > 0 ? "article" : "pre");
    article.className = "manual-article";
    if (paths.length > 0) article.innerHTML = DOMPurify.sanitize(block.html);
    else article.textContent = block.text;
    section.append(header, article);
    return section;
  });
}

function diffView(hunks, emptyText) {
  const pre = document.createElement("div");
  pre.className = "diff-view";
  if (hunks.length === 0) {
    pre.textContent = emptyText;
    return pre;
  }
  for (const hunk of hunks) {
    const header = document.createElement("span");
    header.className = "diff-hunk";
    header.textContent = `@@ 1.0 line ${hunk.oldStart} · draft line ${hunk.newStart} @@`;
    pre.append(header);
    for (const line of hunk.lines) {
      const row = document.createElement("span");
      row.className = `diff-${line.kind}`;
      row.textContent = `${{ add: "+", del: "-", same: " " }[line.kind]} ${line.text}`;
      pre.append(row);
    }
  }
  return pre;
}

async function renderManualPreview(content) {
  if (!state.selectedPath) return;
  const version = ++state.previewVersion;
  elements.kind.textContent = "RENDERED MANUAL SOURCE";
  elements.title.textContent = state.selectedPath;
  elements.note.textContent = "This preview and editor read the gsv-manual worktree directly. Saving creates an ordinary Git diff there.";
  elements.stats.textContent = `${formatCount(new TextEncoder().encode(content).length)} BYTES · ${formatCount(content.length)} CHARACTERS`;
  if (!state.selectedPath.endsWith(".md")) {
    const pre = document.createElement("pre");
    pre.textContent = content;
    elements.preview.replaceChildren(pre);
    return;
  }
  const data = await requestJson("/api/render-markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (version !== state.previewVersion) return;
  const article = document.createElement("article");
  article.className = "manual-article";
  article.innerHTML = DOMPurify.sanitize(data.html);
  elements.preview.replaceChildren(article);
}

async function refreshDiff() {
  if (!state.selectedPath) {
    elements.diff.textContent = "No file selected.";
    return;
  }
  const version = state.selectionVersion;
  if (state.workspace === "context") {
    const content = elements.source.value;
    const data = await requestJson("/api/context-file-diff", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: state.selectedPath, content }),
    });
    if (version !== state.selectionVersion || content !== elements.source.value) return;
    state.baselineText = data.baseline;
    elements.resetBaseline.hidden = data.baseline === null || data.baseline === content;
    elements.diffLabel.textContent = data.baselinePath
      ? `DIFF VS 1.0 · ${data.baselinePath} · +${data.added} −${data.removed}`
      : "DIFF VS 1.0 · no file at this path in 1.0";
    elements.diff.replaceChildren(diffView(data.hunks, "Same as the 1.0 file."));
    return;
  }
  const data = await requestJson(
    `/api/diff?workspace=${encodeURIComponent(state.workspace)}&path=${encodeURIComponent(state.selectedPath)}`,
  );
  if (version !== state.selectionVersion) return;
  elements.diff.textContent = data.diff || "No worktree diff for this file.";
}

function previewClicked(event) {
  const block = event.target.closest("[data-source-path]");
  if (block?.dataset.sourcePath) {
    void selectFile(block.dataset.sourcePath).catch(showError);
    return;
  }
  if (state.workspace !== "manual") return;
  const anchor = event.target.closest("a[href]");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href || /^(?:[a-z]+:|#)/i.test(href)) return;
  const base = new URL(state.selectedPath, "https://manual.invalid/");
  const resolved = new URL(href, base).pathname.replace(/^\//, "");
  const path = resolved.endsWith("/") ? `${resolved}index.md` : resolved;
  if (state.files.some((file) => file.path === path)) {
    event.preventDefault();
    void selectFile(path).catch(showError);
  }
}

function confirmDiscard() {
  return !state.saving && (!state.dirty || window.confirm("Discard unsaved source changes?"));
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }));
  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

function showError(error) {
  elements.errorMessage.textContent = error instanceof Error ? error.message : String(error);
  elements.errorDialog.showModal();
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

// Tokens are estimated at four bytes each; the real count depends on the model's tokenizer.
function formatSize(bytes) {
  return `${formatCount(bytes)} B ≈${formatCount(Math.round(bytes / 4))} TOK`;
}

function formatChange(before, after) {
  if (before === 0) return "NEW";
  const percent = Math.round(((after - before) / before) * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}
