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
};

await initialize();

async function initialize() {
  state.config = await requestJson("/api/config");
  renderTabs();
  await selectWorkspace(state.config.initialWorkspace);

  elements.refresh.addEventListener("click", () => void refresh());
  elements.search.addEventListener("input", renderFileList);
  elements.source.addEventListener("input", sourceChanged);
  elements.save.addEventListener("click", () => void saveSource());
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
    button.addEventListener("click", () => void selectWorkspace(workspace.id));
    return button;
  }));
}

async function selectWorkspace(workspace) {
  if (workspace === state.workspace) return;
  if (!confirmDiscard()) return;
  state.workspace = workspace;
  state.selectedPath = null;
  state.sourceText = "";
  state.sourceHash = null;
  setDirty(false);
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
    : state.files.find((file) => file.path === "system.ts")?.path;
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
      button.addEventListener("click", () => void selectFile(file.path));
      return button;
    });
  elements.files.replaceChildren(...rows);
}

async function selectFile(path, force = false) {
  if (!path || (!force && path === state.selectedPath)) return;
  if (!force && !confirmDiscard()) return;
  const data = await requestJson(
    `/api/file?workspace=${encodeURIComponent(state.workspace)}&path=${encodeURIComponent(path)}`,
  );
  state.selectedPath = path;
  state.sourceText = data.content;
  state.sourceHash = data.hash;
  elements.source.value = data.content;
  elements.source.disabled = false;
  elements.sourcePath.textContent = path;
  setDirty(false);
  renderFileList();
  await refreshDiff();
  if (state.workspace === "prompts") {
    await renderPromptPreview();
  } else {
    await renderManualPreview(data.content);
  }
}

function sourceChanged() {
  setDirty(elements.source.value !== state.sourceText);
  if (state.workspace === "manual") {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(() => void renderManualPreview(elements.source.value), 160);
  }
}

function setDirty(dirty) {
  state.dirty = dirty;
  elements.save.disabled = !dirty || !state.selectedPath;
  elements.saveState.textContent = dirty ? "UNSAVED" : state.selectedPath ? "SAVED" : "";
  elements.saveState.className = `save-state${dirty ? " is-dirty" : ""}`;
}

async function saveSource() {
  if (!state.dirty || !state.selectedPath) return;
  elements.save.disabled = true;
  elements.saveState.textContent = "SAVING";
  try {
    const data = await requestJson("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: state.workspace,
        path: state.selectedPath,
        content: elements.source.value,
        expectedHash: state.sourceHash,
      }),
    });
    state.sourceText = elements.source.value;
    state.sourceHash = data.hash;
    setDirty(false);
    await refreshDiff();
    if (state.workspace === "prompts") {
      await renderPromptPreview();
    }
  } catch (error) {
    elements.saveState.textContent = "SAVE FAILED";
    elements.saveState.className = "save-state is-error";
    showError(error);
    elements.save.disabled = false;
  }
}

async function renderPromptPreview() {
  const data = await requestJson("/api/prompt-blocks");
  elements.kind.textContent = "EVALUATED PROMPT SOURCES";
  elements.title.textContent = "Repository-defined prompt text";
  elements.note.textContent = data.note;
  elements.stats.textContent = `${data.blocks.length} BLOCKS · ${formatCount(data.bytes)} BYTES · ~${formatCount(data.estimatedTokens)} TOKENS`;

  const groups = data.groups.map((group) => {
    const section = document.createElement("section");
    section.className = "prompt-group";
    const title = document.createElement("h3");
    title.className = "prompt-group-title";
    title.textContent = group.label;
    const blocks = group.blocks.map((block) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `prompt-block is-${group.tone}`;
      button.dataset.sourcePath = block.path;
      const header = document.createElement("header");
      const name = document.createElement("strong");
      name.textContent = block.exportName;
      const meta = document.createElement("small");
      meta.textContent = `${block.path} · ${formatCount(block.bytes)} B · ~${formatCount(block.estimatedTokens)} T`;
      header.append(name, meta);
      const body = document.createElement("pre");
      body.textContent = block.text;
      button.append(header, body);
      return button;
    });
    section.append(title, ...blocks);
    return section;
  });
  elements.preview.replaceChildren(...groups);
}

async function renderManualPreview(content) {
  if (!state.selectedPath) return;
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
  const article = document.createElement("article");
  article.className = "manual-article";
  article.innerHTML = data.html;
  elements.preview.replaceChildren(article);
}

async function refreshDiff() {
  if (!state.selectedPath) {
    elements.diff.textContent = "No file selected.";
    return;
  }
  const data = await requestJson(
    `/api/diff?workspace=${encodeURIComponent(state.workspace)}&path=${encodeURIComponent(state.selectedPath)}`,
  );
  elements.diff.textContent = data.diff || "No worktree diff for this file.";
}

function previewClicked(event) {
  const block = event.target.closest("[data-source-path]");
  if (block?.dataset.sourcePath) {
    void selectFile(block.dataset.sourcePath);
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
    void selectFile(path);
  }
}

function confirmDiscard() {
  return !state.dirty || window.confirm("Discard unsaved source changes?");
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
