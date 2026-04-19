import type { WikiMutationResult, WikiPreviewPayload, WikiState } from "./types";

function normalizePath(value: unknown): string {
  return String(value ?? "").trim().replace(/^\/+/, "").replace(/\/+$/g, "").replace(/\/{2,}/g, "/");
}

function normalizeDbScopedPath(value: unknown, db: string): string {
  const path = normalizePath(value);
  if (!path) {
    return "";
  }
  if (db && (path === "index.md" || path.startsWith("pages/") || path.startsWith("inbox/"))) {
    return `${db}/${path}`;
  }
  return path;
}

function parseSourceLines(input: unknown) {
  return String(input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [left, title] = line.split("::");
      const pivot = left.indexOf(":");
      if (pivot <= 0) {
        throw new Error(`Invalid source line: ${line}`);
      }
      const target = left.slice(0, pivot).trim();
      const path = left.slice(pivot + 1).trim();
      if (!target || !path) {
        throw new Error(`Invalid source line: ${line}`);
      }
      return {
        target,
        path,
        ...(title?.trim() ? { title: title.trim() } : {}),
      };
    });
}

function stripFrontmatter(markdown: string): string {
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    return text;
  }
  return text.slice(end + 5);
}

function extractTitle(markdown: string, fallback: string): string {
  const text = stripFrontmatter(markdown);
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function prepareArticleMarkdown(markdown: string, articleTitle: string): string {
  const text = stripFrontmatter(markdown).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let offset = 0;
  while (offset < lines.length && !lines[offset].trim()) {
    offset += 1;
  }
  const firstLine = lines[offset] ?? "";
  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (headingMatch?.[1]?.trim() === articleTitle) {
    offset += 1;
    while (offset < lines.length && !lines[offset].trim()) {
      offset += 1;
    }
  }
  return lines.slice(offset).join("\n").trim();
}

function stripReadLineNumbers(text: unknown): string {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function inferPreviewMode(path: string, text: string): "markdown" | "text" {
  const normalizedPath = String(path ?? "").toLowerCase();
  if (/\.(md|markdown|mdown|mkd)$/.test(normalizedPath)) {
    return "markdown";
  }
  if (/\.(txt|log|json|yaml|yml|toml|ini|cfg|ts|tsx|js|jsx|rs|py|sh|html|css)$/.test(normalizedPath)) {
    return "text";
  }
  const sample = String(text ?? "").trim();
  if (/^#{1,6}\s/m.test(sample) || /\[[^\]]+\]\([^)]+\)/.test(sample) || /^[-*]\s/m.test(sample)) {
    return "markdown";
  }
  return "text";
}

async function loadSelectedNote(kernel: any, path: string) {
  const readResult = await kernel.request("knowledge.read", { path });
  if (!readResult?.exists) {
    return null;
  }
  return {
    path: readResult.path,
    title: readResult.title || extractTitle(readResult.markdown ?? "", path.split("/").pop() ?? path),
    markdown: readResult.markdown ?? "",
  };
}

export async function loadState(kernel: any, args: any): Promise<WikiState> {
  let errorText = "";
  let selectedDb = String(args?.db ?? "").trim();
  let selectedPath = normalizeDbScopedPath(args?.path ?? "", selectedDb);
  const searchQuery = String(args?.q ?? "").trim();
  const queryText = String(args?.ask ?? "").trim();

  let dbs: WikiState["dbs"] = [];
  let pages: WikiState["pages"] = [];
  let inbox: WikiState["inbox"] = [];
  let selectedNote: WikiState["selectedNote"] = null;
  let searchMatches: WikiState["searchMatches"] = null;
  let queryResult: WikiState["queryResult"] = null;

  try {
    const listResult = await kernel.request("knowledge.db.list", { limit: 200 });
    dbs = Array.isArray(listResult?.dbs) ? listResult.dbs : [];
    if (!selectedDb && dbs.length > 0) {
      selectedDb = dbs[0].id;
    }
  } catch (error) {
    errorText ||= error instanceof Error ? error.message : String(error);
  }

  if (selectedDb) {
    try {
      const pageList = await kernel.request("knowledge.list", {
        prefix: `${selectedDb}/pages`,
        recursive: true,
        limit: 200,
      });
      pages = Array.isArray(pageList?.entries) ? pageList.entries.filter((entry: any) => entry.kind === "file") : [];
    } catch (error) {
      errorText ||= error instanceof Error ? error.message : String(error);
    }

    try {
      const inboxList = await kernel.request("knowledge.list", {
        prefix: `${selectedDb}/inbox`,
        recursive: true,
        limit: 200,
      });
      inbox = Array.isArray(inboxList?.entries) ? inboxList.entries.filter((entry: any) => entry.kind === "file") : [];
    } catch (error) {
      errorText ||= error instanceof Error ? error.message : String(error);
    }

    if (!selectedPath) {
      selectedPath = `${selectedDb}/index.md`;
    }
  }

  if (selectedPath) {
    try {
      selectedNote = await loadSelectedNote(kernel, selectedPath);
      if (!selectedNote && !args?.path && pages.length > 0) {
        selectedPath = pages[0].path;
        selectedNote = await loadSelectedNote(kernel, selectedPath);
      }
    } catch (error) {
      errorText ||= error instanceof Error ? error.message : String(error);
    }
  }

  if (searchQuery && selectedDb) {
    try {
      const result = await kernel.request("knowledge.search", {
        query: searchQuery,
        prefix: selectedDb,
        limit: 30,
      });
      searchMatches = Array.isArray(result?.matches) ? result.matches : [];
    } catch (error) {
      errorText ||= error instanceof Error ? error.message : String(error);
    }
  }

  if (queryText && selectedDb) {
    try {
      queryResult = await kernel.request("knowledge.query", {
        query: queryText,
        prefixes: [`${selectedDb}/pages`],
        limit: 8,
        maxBytes: 5000,
      });
    } catch (error) {
      errorText ||= error instanceof Error ? error.message : String(error);
    }
  }

  return {
    selectedDb,
    selectedPath,
    dbs,
    pages,
    inbox,
    selectedNote,
    searchQuery,
    searchMatches,
    queryText,
    queryResult,
    errorText,
  };
}

export async function getPreview(kernel: any, args: any): Promise<WikiPreviewPayload> {
  try {
    const kind = String(args?.kind ?? "").trim();
    if (kind === "page") {
      const db = String(args?.db ?? "").trim();
      const path = normalizeDbScopedPath(args?.path ?? "", db);
      if (!path) {
        return { ok: false, error: "Preview path is required." };
      }
      const note = await kernel.request("knowledge.read", { path });
      if (!note?.exists) {
        return { ok: false, error: `Page '${path}' does not exist.` };
      }
      const title = note.title || extractTitle(note.markdown ?? "", path.split("/").pop() ?? path);
      return {
        ok: true,
        kind: "page",
        title,
        path: note.path,
        markdown: prepareArticleMarkdown(note.markdown ?? "", title),
      };
    }

    if (kind === "source") {
      const target = String(args?.target ?? "").trim();
      const path = String(args?.path ?? "").trim();
      const title = String(args?.title ?? "").trim();
      if (!target || !path) {
        return { ok: false, error: "Source target and path are required." };
      }
      if (target !== "gsv") {
        return {
          ok: true,
          kind: "source",
          target,
          path,
          title: title || path.split("/").pop() || path,
          mode: "unavailable",
          text: `Preview is not available yet for target '${target}'.`,
        };
      }
      const source = await kernel.request("fs.read", { path });
      if (!source?.ok) {
        return { ok: false, error: source?.error || `Failed to read ${path}` };
      }
      if ("files" in source) {
        return {
          ok: true,
          kind: "source",
          target,
          path: source.path,
          title: title || source.path.split("/").pop() || source.path,
          mode: "directory",
          files: source.files ?? [],
          directories: source.directories ?? [],
        };
      }
      if (Array.isArray(source.content)) {
        const textItem = source.content.find((item: any) => item.type === "text");
        const imageItem = source.content.find((item: any) => item.type === "image");
        return {
          ok: true,
          kind: "source",
          target,
          path: source.path,
          title: title || source.path.split("/").pop() || source.path,
          mode: imageItem ? "image" : "text",
          text: textItem?.type === "text" ? textItem.text : "",
          image: imageItem?.type === "image" ? imageItem : null,
        };
      }
      const text = stripReadLineNumbers(source.content);
      return {
        ok: true,
        kind: "source",
        target,
        path: source.path,
        title: title || source.path.split("/").pop() || source.path,
        mode: inferPreviewMode(source.path, text),
        text,
      };
    }

    return { ok: false, error: "Unknown preview kind." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createDatabase(kernel: any, args: any): Promise<WikiMutationResult> {
  const dbId = String(args?.dbId ?? "").trim();
  const dbTitle = String(args?.dbTitle ?? "").trim();
  if (!dbId) {
    throw new Error("A database id is required.");
  }
  const result = await kernel.request("knowledge.db.init", {
    id: dbId,
    title: dbTitle || undefined,
  });
  if (!result?.ok) {
    throw new Error(result?.error || "Failed to create database");
  }
  return {
    db: result.id,
    openPath: `${result.id}/index.md`,
    statusText: result.created ? `Created ${result.id}` : `${result.id} already existed`,
  };
}

export async function writePage(kernel: any, args: any): Promise<WikiMutationResult> {
  const selectedDb = String(args?.db ?? "").trim();
  const path = normalizeDbScopedPath(args?.path ?? "", selectedDb);
  const markdown = String(args?.markdown ?? "");
  if (!path) {
    throw new Error("A knowledge path is required.");
  }
  const result = await kernel.request("knowledge.write", {
    path,
    markdown,
    mode: "replace",
    create: true,
  });
  if (!result?.ok) {
    throw new Error(result?.error || "Failed to save note");
  }
  return {
    db: result.path.includes("/") ? String(result.path).split("/")[0] : selectedDb,
    openPath: result.path,
    statusText: result.created ? `Created ${result.path}` : `Saved ${result.path}`,
  };
}

export async function ingestSourcesToInbox(kernel: any, args: any): Promise<WikiMutationResult> {
  const selectedDb = String(args?.db ?? "").trim();
  const title = String(args?.title ?? "").trim();
  const summary = String(args?.summary ?? "").trim();
  const sources = parseSourceLines(args?.sources ?? "");
  if (!selectedDb) {
    throw new Error("Select a database before ingesting sources.");
  }
  const result = await kernel.request("knowledge.ingest", {
    db: selectedDb,
    sources,
    title: title || undefined,
    summary: summary || undefined,
    mode: "inbox",
  });
  if (!result?.ok) {
    throw new Error(result?.error || "Failed to ingest sources");
  }
  return {
    db: selectedDb,
    openPath: result.path,
    statusText: `Staged ${result.path}`,
  };
}

export async function compileInboxNote(kernel: any, args: any): Promise<WikiMutationResult> {
  const selectedDb = String(args?.db ?? "").trim();
  const sourcePath = normalizeDbScopedPath(args?.sourcePath ?? "", selectedDb);
  const targetPath = normalizeDbScopedPath(args?.targetPath ?? "", selectedDb);
  if (!selectedDb) {
    throw new Error("Select a database before compiling inbox notes.");
  }
  if (!sourcePath.startsWith(`${selectedDb}/inbox/`)) {
    throw new Error("Only inbox notes can be compiled.");
  }
  const result = await kernel.request("knowledge.compile", {
    db: selectedDb,
    sourcePath,
    targetPath: targetPath || undefined,
  });
  if (!result?.ok) {
    throw new Error(result?.error || "Failed to compile inbox note");
  }
  return {
    db: selectedDb,
    openPath: result.path,
    statusText: `Compiled ${result.sourcePath} into ${result.path}`,
  };
}

export async function startBuildFromDirectory(kernel: any, args: any): Promise<WikiMutationResult> {
  const buildTarget = String(args?.buildTarget ?? "gsv").trim() || "gsv";
  const buildSourcePath = String(args?.buildSourcePath ?? "").trim();
  const buildDbId = String(args?.buildDbId ?? "").trim();
  const buildDbTitle = String(args?.buildDbTitle ?? "").trim();
  if (!buildDbId) {
    throw new Error("A target database id is required.");
  }
  if (!buildSourcePath) {
    throw new Error("A source directory is required.");
  }

  const spawn = await kernel.request("proc.spawn", {
    profile: "wiki#builder",
    label: `wiki build (${buildDbId})`,
    workspace: { mode: "none" },
  });
  if (!spawn?.ok) {
    throw new Error(spawn?.error || "Failed to start wiki builder");
  }

  const watchKey = `wiki-build:${spawn.pid}`;
  await kernel.request("signal.watch", {
    signal: "chat.complete",
    processId: spawn.pid,
    key: watchKey,
    state: {
      db: buildDbId,
      title: buildDbTitle || undefined,
      sourceTarget: buildTarget,
      sourcePath: buildSourcePath,
    },
  });

  const prompt = [
    "Build a knowledge wiki from a directory.",
    `Source target: ${buildTarget}`,
    `Source directory: ${buildSourcePath}`,
    `Target database: ${buildDbId}`,
    ...(buildDbTitle ? [`Database title: ${buildDbTitle}`] : []),
    "",
    "Requirements:",
    "- The source directory may be on a device target, but the wiki itself must be created on gsv under ~/knowledge.",
    "- Treat the source target as read-only. Do not create wiki files, support files, or scratch files there.",
    "- Use the `wiki` CLI on gsv for all wiki writes; do not hand-create page files in the source directory or on the source target.",
    "- Use normal filesystem/shell tools only to inspect the source corpus.",
    "- Initialize the target database if it does not exist.",
    "- Inspect the source directory conservatively and ignore obvious junk such as build output, vendor directories, and caches unless they are clearly relevant.",
    "- Create a readable `index.md` homepage for the database.",
    "- Create canonical pages under `<db>/pages/` with meaningful boundaries instead of one giant dump.",
    "- Add links between related pages.",
    "- Keep live source references back to the original files and directories.",
    "- Do not copy the source corpus into the knowledge repo.",
    "- Prefer a small useful first draft over exhaustive coverage.",
  ].join("\n");

  const send = await kernel.request("proc.send", {
    pid: spawn.pid,
    message: prompt,
  });
  if (!send?.ok) {
    await kernel.request("signal.unwatch", { key: watchKey }).catch(() => {});
    throw new Error(send?.error || "Failed to deliver builder prompt");
  }

  return {
    db: buildDbId,
    openPath: `${buildDbId}/index.md`,
    statusText: `Started background wiki build for ${buildDbId}. You will get a notification when it finishes.`,
  };
}

function readBuildWatchState(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const state = value as Record<string, unknown>;
  const db = typeof state.db === "string" ? state.db.trim() : "";
  const sourceTarget = typeof state.sourceTarget === "string" ? state.sourceTarget.trim() : "";
  const sourcePath = typeof state.sourcePath === "string" ? state.sourcePath.trim() : "";
  const title = typeof state.title === "string" ? state.title.trim() : "";
  if (!db || !sourceTarget || !sourcePath) {
    return null;
  }
  return { db, sourceTarget, sourcePath, title };
}

export async function handleAppSignal(ctx: any) {
  if (ctx.signal !== "chat.complete") {
    return;
  }
  const state = readBuildWatchState(ctx.watch?.state);
  if (!state) {
    return;
  }
  const payload = ctx.payload && typeof ctx.payload === "object" ? ctx.payload : {};
  const error = typeof (payload as Record<string, unknown>).error === "string" && (payload as Record<string, unknown>).error
    ? String((payload as Record<string, unknown>).error).trim()
    : "";

  await ctx.kernel.request("notification.create", {
    title: error ? `Wiki build failed: ${state.db}` : `Wiki build finished: ${state.db}`,
    body: error
      ? `${state.sourceTarget}:${state.sourcePath} failed with: ${error}`
      : `${state.sourceTarget}:${state.sourcePath} was compiled into the ${state.db} wiki.`,
    level: error ? "error" : "success",
    actions: [
      {
        kind: "open_app",
        label: "Open wiki",
        target: `${ctx.meta.routeBase ?? "/apps/wiki"}?db=${encodeURIComponent(state.db)}&path=${encodeURIComponent(`${state.db}/index.md`)}`,
      },
    ],
  });
}
