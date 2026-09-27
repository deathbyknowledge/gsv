import DOMPurify from "/sanitize.js";

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
  elements.account.addEventListener("change", () => void renderPromptPreview().catch(showError));
  elements.view.addEventListener("change", () => void renderPromptPreview().catch(showError));
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
  setDirty(false);
  elements.promptControls.hidden = workspace !== "prompts";
  renderTabs();
  await refresh();
}

async function refresh() {
  if (state.dirty && !confirmDiscard()) return;
  const data = await requestJson(`/api/files?workspace=${encodeURIComponent(state.workspace)}`);
  state.files = data.files;
  elements.root.textContent = data.root;
  elements.root.title = data.root;
  renderFileList();

  const currentExists = state.files.some((file) => file.path === state.selectedPath);
  const preferred = state.workspace === "manual"
    ? state.files.find((file) => file.path === "index.md")?.path
    : state.files.find((file) => file.path === "ship/00-role.md")?.path;
  if (!currentExists) {
    await selectFile(preferred ?? state.files[0]?.path ?? null);
  } else if (state.selectedPath) {
    await selectFile(state.selectedPath, true);
  }
}

function renderFileList() {
  const query = elements.search.value.trim().toLowerCase();
  const rows = state.files
    .filter((file) => !query || file.path.toLowerCase().includes(query))
    .map((file) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `file-row${file.path === state.selectedPath ? " is-active" : ""}`;
      button.textContent = file.path;
      button.title = `${file.bytes.toLocaleString()} bytes`;
      button.addEventListener("click", () => void selectFile(file.path).catch(showError));
      return button;
    });
  elements.files.replaceChildren(...rows);
}

async function selectFile(path, force = false) {
  if (!path || (!force && path === state.selectedPath)) return;
  if (!force && !confirmDiscard()) return;
  const version = ++state.selectionVersion;
  clearTimeout(state.renderTimer);
  state.previewVersion++;
  const data = await requestJson(
    `/api/file?workspace=${encodeURIComponent(state.workspace)}&path=${encodeURIComponent(path)}`,
  );
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
    if (path.startsWith("ship/")) elements.account.value = "ship";
    if (path.startsWith("crew/") || path.startsWith("agent/")) elements.account.value = "crew";
    if (path.startsWith("tasks/")) elements.view.value = "catalog";
    await renderPromptPreview();
  } else {
    await renderManualPreview(data.content);
  }
}

function sourceChanged() {
  setDirty(elements.source.value !== state.sourceText);
  state.previewVersion++;
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    const rendering = state.workspace === "prompts" ? renderPromptPreview() : renderManualPreview(elements.source.value);
    void rendering.catch(showError);
  }, 200);
}

function setDirty(dirty) {
  state.dirty = dirty;
  elements.save.disabled = state.saving || !dirty || !state.selectedPath;
  elements.saveState.textContent = dirty ? "UNSAVED" : state.selectedPath ? "SAVED" : "";
  elements.saveState.className = `save-state${dirty ? " is-dirty" : ""}`;
}

async function saveSource() {
  if (!state.dirty || !state.selectedPath || state.saving) return;
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
  if (state.workspace === "prompts") void renderPromptPreview().catch(showError);
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
  elements.kind.textContent = "REPOSITORY DEFAULTS";
  elements.title.textContent = view === "catalog" ? "All prompt sources" : `${account === "ship" ? "Ship" : "Crew"} · assembled prompt`;
  elements.note.textContent = "Sample account and runtime. Saved edits change this worktree; space overrides stay intact.";
  const bytes = new TextEncoder().encode(view === "catalog" ? data.catalog.map((source) => source.text).join("") : data.prompt).length;
  elements.stats.textContent = `${view === "catalog" ? `${data.catalog.length} SOURCES` : `${data.sections.length} SECTIONS`} · ${formatCount(bytes)} BYTES`;
  const scrollTop = elements.preview.scrollTop;
  if (view === "exact") {
    const pre = document.createElement("pre");
    pre.className = "exact-prompt";
    pre.textContent = data.prompt;
    elements.preview.replaceChildren(pre);
  } else {
    const blocks = view === "catalog" ? data.catalog : data.sections;
    elements.preview.replaceChildren(...blocks.map((block) => {
      const section = document.createElement("section");
      const root = block.contextRoot?.key;
      section.className = `prompt-block is-${root === "system" ? "system" : "personal"}`;
      section.classList.toggle("is-selected", block.path === state.selectedPath);
      const header = document.createElement("header");
      const name = document.createElement(block.path ? "button" : "strong");
      if (block.path) {
        name.type = "button";
        name.dataset.sourcePath = block.path;
      }
      name.textContent = block.path ?? "Available skills · generated";
      const meta = document.createElement("small");
      meta.textContent = `${formatCount(new TextEncoder().encode(block.text).length)} B`;
      header.append(name, meta);
      const article = document.createElement(block.path ? "article" : "pre");
      article.className = "manual-article";
      if (block.path) article.innerHTML = DOMPurify.sanitize(block.html);
      else article.textContent = block.text;
      section.append(header, article);
      return section;
    }));
  }
  elements.preview.scrollTop = scrollTop;
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
