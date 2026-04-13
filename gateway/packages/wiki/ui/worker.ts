function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizePath(value) {
  return String(value ?? "").trim().replace(/^\/+/, "").replace(/\/+$/g, "").replace(/\/+/g, "/");
}

function normalizeDbScopedPath(value, db) {
  const path = normalizePath(value);
  if (!path) {
    return "";
  }
  if (db && (path === "index.md" || path.startsWith("pages/") || path.startsWith("inbox/"))) {
    return `${db}/${path}`;
  }
  return path;
}

function buildEntryHref(routeBase, db, path) {
  const href = new URL(routeBase, "https://app.local/");
  const effectiveDb = db || (path && path.includes("/") ? String(path).split("/")[0] : "");
  if (effectiveDb) {
    href.searchParams.set("db", effectiveDb);
  }
  if (path) {
    href.searchParams.set("path", path);
  }
  return href.pathname + href.search;
}

function parseSourceLines(input) {
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
        ...(title && title.trim() ? { title: title.trim() } : {}),
      };
    });
}

function stripFrontmatter(markdown) {
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

function extractTitle(markdown, fallback) {
  const text = stripFrontmatter(markdown);
  const match = text.match(/^#\s+(.+)$/m);
  if (match && match[1]) {
    return match[1].trim();
  }
  return fallback;
}

function slugifyHeading(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
}

function extractHeadings(markdown) {
  const lines = stripFrontmatter(markdown).split("\n");
  const headings = [];
  for (const line of lines) {
    const match = line.match(/^(#{2,4})\s+(.+)$/);
    if (!match) {
      continue;
    }
    const text = match[2].trim();
    headings.push({
      level: match[1].length,
      text,
      id: slugifyHeading(text),
    });
  }
  return headings;
}

function formatPlainSegment(segment) {
  let html = escapeHtml(segment);
  html = html.replace(/\*\*([^*]+)\*\*/g, (_, value) => `<strong>${escapeHtml(value)}</strong>`);
  html = html.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, (_, prefix, value) => `${prefix}<em>${escapeHtml(value)}</em>`);
  html = html.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, (_, prefix, value) => `${prefix}<em>${escapeHtml(value)}</em>`);
  return html;
}

function resolveMarkdownHref(rawHref, selectedDb) {
  const href = String(rawHref ?? "").trim();
  if (!href) {
    return null;
  }
  if (/^(https?:|mailto:|#)/i.test(href)) {
    return { kind: "external", href };
  }
  if (/^[a-z0-9._-]+:\/\//i.test(href)) {
    return { kind: "external", href };
  }
  if (/^[a-z0-9._-]+\/(pages|inbox)\//i.test(href) || /^[a-z0-9._-]+\/index\.md$/i.test(href)) {
    return { kind: "internal", path: normalizePath(href) };
  }
  if (selectedDb && (href === "index.md" || href.startsWith("pages/") || href.startsWith("inbox/"))) {
    return { kind: "internal", path: normalizeDbScopedPath(href, selectedDb) };
  }
  return { kind: "external", href };
}

function renderInlineMarkdown(text, routeBase, selectedDb) {
  const chunks = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      chunks.push(formatPlainSegment(text.slice(cursor, match.index)));
    }
    if (match[1] != null) {
      chunks.push(`<code>${escapeHtml(match[1])}</code>`);
    } else {
      const label = escapeHtml(match[2] ?? "");
      const resolved = resolveMarkdownHref(match[3] ?? "", selectedDb);
      if (resolved?.kind === "internal") {
        chunks.push(`<a href="${escapeHtml(buildEntryHref(routeBase, selectedDb, resolved.path))}">${label}</a>`);
      } else if (resolved?.href) {
        chunks.push(`<a href="${escapeHtml(resolved.href)}" target="_blank" rel="noreferrer">${label}</a>`);
      } else {
        chunks.push(label);
      }
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) {
    chunks.push(formatPlainSegment(text.slice(cursor)));
  }
  return chunks.join("");
}

function renderMarkdown(markdown, routeBase, selectedDb, articleTitle) {
  const text = stripFrontmatter(markdown).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const html = [];
  let paragraph = [];
  let listItems = [];
  let quoteLines = [];
  let codeFence = false;
  let codeLines = [];
  let skippedTitle = false;

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "), routeBase, selectedDb)}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (listItems.length === 0) {
      return;
    }
    html.push(`<ul>${listItems.map((item) => `<li>${renderInlineMarkdown(item, routeBase, selectedDb)}</li>`).join("")}</ul>`);
    listItems = [];
  }

  function flushQuote() {
    if (quoteLines.length === 0) {
      return;
    }
    html.push(`<blockquote><p>${renderInlineMarkdown(quoteLines.join(" "), routeBase, selectedDb)}</p></blockquote>`);
    quoteLines = [];
  }

  function flushCode() {
    if (codeLines.length === 0) {
      return;
    }
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
  }

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushQuote();
      if (codeFence) {
        flushCode();
        codeFence = false;
      } else {
        codeFence = true;
      }
      continue;
    }

    if (codeFence) {
      codeLines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(heading[1].length + 1, 6);
      const textValue = heading[2].trim();
      if (!skippedTitle && heading[1].length === 1 && textValue === articleTitle) {
        skippedTitle = true;
        continue;
      }
      html.push(`<h${level} id="${escapeHtml(slugifyHeading(textValue))}">${renderInlineMarkdown(textValue, routeBase, selectedDb)}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      flushQuote();
      listItems.push(listItem[1]);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push("<hr />");
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCode();

  return html.join("\n");
}

function renderDbList(dbs, selectedDb, routeBase) {
  if (!Array.isArray(dbs) || dbs.length === 0) {
    return '<p class="muted">No knowledge databases yet.</p>';
  }
  return `<ul class="nav-list">${dbs.map((db) => {
    const selected = db.id === selectedDb ? ' aria-current="page"' : "";
    return `<li><a${selected} href="${escapeHtml(buildEntryHref(routeBase, db.id, ""))}">${escapeHtml(db.title || db.id)}</a><div class="nav-meta">${escapeHtml(db.id)}</div></li>`;
  }).join("")}</ul>`;
}

function renderEntryList(entries, selectedPath, routeBase, selectedDb, emptyText) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul class="nav-list">${entries.map((entry) => {
    const selected = entry.path === selectedPath ? ' aria-current="page"' : "";
    const label = entry.title || entry.path.split("/").pop() || entry.path;
    return `<li><a${selected} href="${escapeHtml(buildEntryHref(routeBase, selectedDb, entry.path))}">${escapeHtml(label)}</a><div class="nav-meta">${escapeHtml(entry.path)}</div></li>`;
  }).join("")}</ul>`;
}

function renderSearchResults(matches, routeBase, selectedDb) {
  if (!Array.isArray(matches)) {
    return "";
  }
  if (matches.length === 0) {
    return '<p class="muted">No entries matched the current search.</p>';
  }
  return `<ul class="result-list">${matches.map((match) => `<li><a href="${escapeHtml(buildEntryHref(routeBase, selectedDb, match.path))}">${escapeHtml(match.title || match.path)}</a><div class="nav-meta">${escapeHtml(match.path)}</div><div>${escapeHtml(match.snippet || "")}</div></li>`).join("")}</ul>`;
}

function renderQueryRefs(refs, routeBase, selectedDb) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return "";
  }
  return `<ul class="result-list">${refs.map((ref) => `<li><a href="${escapeHtml(buildEntryHref(routeBase, selectedDb, ref.path))}">${escapeHtml(ref.title || ref.path)}</a><div class="nav-meta">${escapeHtml(ref.path)}</div></li>`).join("")}</ul>`;
}

function renderToc(headings) {
  if (!Array.isArray(headings) || headings.length === 0) {
    return '<p class="muted">No section headings in this page yet.</p>';
  }
  return `<ol class="toc-list">${headings.map((heading) => `<li class="level-${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`).join("")}</ol>`;
}

function renderPage(args) {
  const {
    routeBase,
    dbs,
    selectedDb,
    pages,
    inbox,
    selectedPath,
    selectedNote,
    searchQuery,
    searchMatches,
    queryText,
    queryResult,
    statusText,
    errorText,
    draftPath,
    draftMarkdown,
    newDbId,
    newDbTitle,
    ingestSources,
    ingestTitle,
    ingestSummary,
    compileTarget,
  } = args;

  const articleMarkdown = selectedNote?.markdown ?? draftMarkdown ?? "";
  const articleTitle = selectedNote?.title ?? extractTitle(articleMarkdown, selectedPath ? selectedPath.split("/").pop() ?? selectedPath : (selectedDb || "Wiki"));
  const articleHtml = articleMarkdown ? renderMarkdown(articleMarkdown, routeBase, selectedDb, articleTitle) : "";
  const headings = extractHeadings(articleMarkdown);
  const canCompile = Boolean(selectedDb && selectedPath.startsWith(`${selectedDb}/inbox/`));
  const pathInput = draftPath || (selectedDb ? `${selectedDb}/pages/topic.md` : "product/pages/topic.md");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wiki</title>
    <link rel="stylesheet" href="/runtime/theme.css" />
    <style>
      :root {
        color-scheme: light;
        --bg: #f8f9fa;
        --surface: #ffffff;
        --surface-subtle: #f6f6f6;
        --line: #a2a9b1;
        --line-soft: #d8dde3;
        --text: #202122;
        --muted: #54595d;
        --link: #0645ad;
        --visited: #0b0080;
        --accent: #3366cc;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
      body {
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }
      a:visited { color: var(--visited); }
      code, pre {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      .masthead {
        border-bottom: 1px solid var(--line);
        background: var(--surface);
        padding: 10px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .wordmark {
        font: 700 25px/1.05 Charter, "Iowan Old Style", Georgia, serif;
        letter-spacing: -0.02em;
      }
      .tagline {
        color: var(--muted);
        font-size: 12px;
      }
      .frame {
        min-height: calc(100vh - 58px);
        display: grid;
        grid-template-columns: 270px minmax(0, 1fr) 320px;
      }
      .rail {
        min-height: 0;
        overflow: auto;
        background: var(--surface-subtle);
      }
      .rail.left {
        border-right: 1px solid var(--line);
      }
      .rail.right {
        border-left: 1px solid var(--line);
      }
      .panel {
        padding: 14px 16px;
        border-bottom: 1px solid var(--line-soft);
      }
      .panel h2, .panel h3 {
        margin: 0 0 8px;
        font-size: 14px;
        font-weight: 700;
      }
      .panel h2 {
        font-size: 16px;
        font-family: Charter, "Iowan Old Style", Georgia, serif;
      }
      .muted {
        margin: 0;
        color: var(--muted);
      }
      .nav-list, .result-list, .toc-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .nav-list li, .result-list li {
        padding: 5px 0;
      }
      .nav-meta {
        color: var(--muted);
        font-size: 12px;
        word-break: break-all;
      }
      .nav-list a[aria-current="page"] {
        font-weight: 700;
        color: var(--text);
      }
      .article-wrap {
        min-width: 0;
        background: var(--surface);
      }
      .notice-stack {
        padding: 14px 24px 0;
        display: grid;
        gap: 8px;
      }
      .notice {
        padding: 10px 12px;
        border: 1px solid var(--line);
        background: #f8fbff;
      }
      .notice.error {
        background: #fff3f0;
      }
      .article {
        max-width: 920px;
        padding: 22px 30px 40px;
        margin: 0 auto;
      }
      .breadcrumbs {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 8px;
      }
      .article h1 {
        margin: 0;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--line-soft);
        font: 400 36px/1.12 Charter, "Iowan Old Style", Georgia, serif;
      }
      .article .page-path {
        margin: 8px 0 22px;
        color: var(--muted);
        font-size: 12px;
        word-break: break-all;
      }
      .article-body {
        font-size: 15px;
      }
      .article-body h2,
      .article-body h3,
      .article-body h4,
      .article-body h5,
      .article-body h6 {
        margin: 28px 0 10px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--line-soft);
        font-family: Charter, "Iowan Old Style", Georgia, serif;
        font-weight: 600;
      }
      .article-body p,
      .article-body ul,
      .article-body ol,
      .article-body blockquote,
      .article-body pre {
        margin: 0 0 16px;
      }
      .article-body ul,
      .article-body ol {
        padding-left: 24px;
      }
      .article-body blockquote {
        padding-left: 14px;
        border-left: 3px solid var(--line);
        color: var(--muted);
      }
      .article-body pre {
        padding: 12px 14px;
        border: 1px solid var(--line-soft);
        background: var(--surface-subtle);
        overflow: auto;
      }
      .article-body hr {
        border: 0;
        border-top: 1px solid var(--line-soft);
        margin: 22px 0;
      }
      .article-body code {
        padding: 1px 4px;
        background: var(--surface-subtle);
      }
      .tools form,
      .tools details {
        margin: 0 0 14px;
      }
      .tools details {
        border: 1px solid var(--line-soft);
        background: var(--surface);
      }
      .tools summary {
        cursor: pointer;
        padding: 10px 12px;
        font-weight: 700;
      }
      .tools .detail-body {
        padding: 0 12px 12px;
        border-top: 1px solid var(--line-soft);
      }
      .field {
        display: grid;
        gap: 5px;
        margin: 0 0 12px;
      }
      .field label {
        font-size: 12px;
        color: var(--muted);
      }
      input[type="text"],
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--text);
        font: inherit;
        padding: 8px 10px;
        outline: none;
      }
      textarea {
        min-height: 140px;
        resize: vertical;
      }
      button {
        min-height: 34px;
        padding: 0 12px;
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--text);
        font: inherit;
        cursor: pointer;
      }
      button.primary {
        border-color: var(--accent);
        color: var(--accent);
      }
      .toc-list li {
        margin: 0 0 6px;
      }
      .toc-list .level-3 { padding-left: 12px; }
      .toc-list .level-4 { padding-left: 24px; }
      .empty-article {
        padding: 18px 0;
        color: var(--muted);
      }
      @media (max-width: 1180px) {
        .frame {
          grid-template-columns: 240px minmax(0, 1fr);
        }
        .rail.right {
          grid-column: 1 / -1;
          border-left: 0;
          border-top: 1px solid var(--line);
        }
      }
      @media (max-width: 840px) {
        .frame {
          grid-template-columns: 1fr;
        }
        .rail.left {
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }
        .article {
          padding: 18px 16px 28px;
        }
      }
    </style>
  </head>
  <body>
    <header class="masthead">
      <div>
        <div class="wordmark">Wiki</div>
        <div class="tagline">Compiled knowledge pages with explicit inbox review and live source references.</div>
      </div>
      <div class="tagline">${escapeHtml(selectedDb || "no database selected")}</div>
    </header>
    <main class="frame">
      <aside class="rail left">
        <section class="panel">
          <h2>Databases</h2>
          ${renderDbList(dbs, selectedDb, routeBase)}
        </section>
        <section class="panel">
          <h3>Pages</h3>
          ${selectedDb ? renderEntryList(pages, selectedPath, routeBase, selectedDb, "No canonical pages yet.") : '<p class="muted">Select a database to browse pages.</p>'}
        </section>
        <section class="panel">
          <h3>Inbox</h3>
          ${selectedDb ? renderEntryList(inbox, selectedPath, routeBase, selectedDb, "No staged inbox notes.") : '<p class="muted">Select a database to browse inbox notes.</p>'}
        </section>
      </aside>
      <section class="article-wrap">
        <div class="notice-stack">
          ${statusText ? `<div class="notice">${escapeHtml(statusText)}</div>` : ""}
          ${errorText ? `<div class="notice error">${escapeHtml(errorText)}</div>` : ""}
        </div>
        <article class="article">
          <div class="breadcrumbs">${escapeHtml(selectedDb || "wiki")} ${selectedPath ? ` / ${escapeHtml(selectedPath)}` : ""}</div>
          <h1>${escapeHtml(articleTitle || "Wiki")}</h1>
          <div class="page-path">${selectedPath ? escapeHtml(selectedPath) : "No page selected."}</div>
          <div class="article-body">
            ${articleHtml || '<div class="empty-article">Open a page from the left rail, create a new page, or stage source material into an inbox note.</div>'}
          </div>
        </article>
      </section>
      <aside class="rail right">
        <section class="panel tools">
          <h2>Page tools</h2>
          ${headings.length > 0 ? `<div style="margin-bottom:14px;"><h3>Contents</h3>${renderToc(headings)}</div>` : ""}
          <form method="get" action="${escapeHtml(routeBase)}">
            ${selectedDb ? `<input type="hidden" name="db" value="${escapeHtml(selectedDb)}" />` : ""}
            ${selectedPath ? `<input type="hidden" name="path" value="${escapeHtml(selectedPath)}" />` : ""}
            <div class="field">
              <label for="wiki-search">Search</label>
              <input id="wiki-search" type="text" name="q" value="${escapeHtml(searchQuery)}" placeholder="Find pages or inbox notes" />
            </div>
            <div class="field">
              <label for="wiki-query">Query</label>
              <input id="wiki-query" type="text" name="ask" value="${escapeHtml(queryText)}" placeholder="What does this wiki say about auth?" />
            </div>
            <button type="submit" class="primary">Refresh view</button>
          </form>
          ${queryText && queryResult ? `<details open><summary>Query result</summary><div class="detail-body"><div style="white-space:pre-wrap; margin-bottom:12px;">${escapeHtml(queryResult.brief ?? "")}</div>${renderQueryRefs(queryResult.refs, routeBase, selectedDb)}</div></details>` : ""}
          ${searchQuery ? `<details open><summary>Search matches</summary><div class="detail-body">${renderSearchResults(searchMatches, routeBase, selectedDb)}</div></details>` : ""}
          <details>
            <summary>Write page</summary>
            <div class="detail-body">
              <form method="post" action="${escapeHtml(routeBase)}">
                <input type="hidden" name="db" value="${escapeHtml(selectedDb)}" />
                <div class="field">
                  <label for="wiki-path">Path</label>
                  <input id="wiki-path" type="text" name="path" value="${escapeHtml(pathInput)}" placeholder="${escapeHtml(selectedDb ? "pages/topic.md" : "product/pages/topic.md")}" />
                </div>
                <div class="field">
                  <label for="wiki-markdown">Markdown</label>
                  <textarea id="wiki-markdown" name="markdown" placeholder="# Topic\n\n## Summary\nCompiled knowledge goes here.">${escapeHtml(articleMarkdown || draftMarkdown)}</textarea>
                </div>
                <button type="submit" class="primary" name="action" value="write">Save page</button>
                ${canCompile ? `<button type="submit" style="margin-left:8px;" name="action" value="compile">Compile inbox note</button>` : ""}
                ${canCompile ? `<div class="field" style="margin-top:12px;"><label for="compile-target">Compile target</label><input id="compile-target" type="text" name="targetPath" value="${escapeHtml(compileTarget)}" placeholder="pages/compiled-page.md" /></div>` : ""}
              </form>
            </div>
          </details>
          <details>
            <summary>Stage source refs</summary>
            <div class="detail-body">
              <form method="post" action="${escapeHtml(routeBase)}">
                <input type="hidden" name="action" value="ingest" />
                <input type="hidden" name="db" value="${escapeHtml(selectedDb)}" />
                <div class="field">
                  <label for="ingest-title">Title</label>
                  <input id="ingest-title" type="text" name="title" value="${escapeHtml(ingestTitle)}" placeholder="Adapter UX inputs" />
                </div>
                <div class="field">
                  <label for="ingest-summary">Summary</label>
                  <input id="ingest-summary" type="text" name="summary" value="${escapeHtml(ingestSummary)}" placeholder="Collected notes for onboarding and approval UX" />
                </div>
                <div class="field">
                  <label for="ingest-sources">Sources</label>
                  <textarea id="ingest-sources" name="sources" placeholder="gsv:/workspaces/gsv/docs/alpha-plan.md::Alpha plan&#10;macbook:/Users/hank/Downloads/adapter-notes.txt::Adapter notes">${escapeHtml(ingestSources)}</textarea>
                </div>
                <button type="submit">Stage sources</button>
              </form>
            </div>
          </details>
          <details>
            <summary>Create database</summary>
            <div class="detail-body">
              <form method="post" action="${escapeHtml(routeBase)}">
                <input type="hidden" name="action" value="db-init" />
                <div class="field">
                  <label for="db-id">Id</label>
                  <input id="db-id" type="text" name="dbId" value="${escapeHtml(newDbId)}" placeholder="product-alpha" />
                </div>
                <div class="field">
                  <label for="db-title">Title</label>
                  <input id="db-title" type="text" name="dbTitle" value="${escapeHtml(newDbTitle)}" placeholder="Product Alpha" />
                </div>
                <button type="submit">Create database</button>
              </form>
            </div>
          </details>
        </section>
      </aside>
    </main>
  </body>
</html>`;
}

export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};
  const appFrame = props.appFrame;
  const kernel = props.kernel;
  if (!appFrame || !kernel) {
    return new Response("App frame missing", { status: 500 });
  }

  const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/wiki";
  const url = new URL(request.url);
  if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
    return new Response("Not Found", { status: 404 });
  }

  let statusText = "";
  let errorText = "";
  let selectedDb = String(url.searchParams.get("db") ?? "").trim();
  let selectedPath = normalizeDbScopedPath(url.searchParams.get("path") ?? "", selectedDb);
  let draftPath = selectedPath;
  let draftMarkdown = "";
  let newDbId = "";
  let newDbTitle = "";
  let ingestSources = "";
  let ingestTitle = "";
  let ingestSummary = "";
  let compileTarget = "";
  const searchQuery = String(url.searchParams.get("q") ?? "").trim();
  const queryText = String(url.searchParams.get("ask") ?? "").trim();

  if (request.method === "POST") {
    try {
      const form = await request.formData();
      const action = String(form.get("action") ?? "").trim();
      selectedDb = String(form.get("db") ?? selectedDb).trim();
      selectedPath = normalizeDbScopedPath(form.get("path") ?? selectedPath, selectedDb);
      draftPath = selectedPath;
      draftMarkdown = String(form.get("markdown") ?? "");
      newDbId = String(form.get("dbId") ?? "").trim();
      newDbTitle = String(form.get("dbTitle") ?? "").trim();
      ingestSources = String(form.get("sources") ?? "");
      ingestTitle = String(form.get("title") ?? "").trim();
      ingestSummary = String(form.get("summary") ?? "").trim();
      compileTarget = normalizeDbScopedPath(form.get("targetPath") ?? "", selectedDb);

      if (action === "db-init") {
        if (!newDbId) {
          throw new Error("A database id is required.");
        }
        const result = await kernel.request("knowledge.db.init", {
          id: newDbId,
          title: newDbTitle || undefined,
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Failed to create database");
        }
        selectedDb = result.id;
        selectedPath = `${result.id}/index.md`;
        statusText = result.created ? `Created ${result.id}` : `${result.id} already existed`;
      } else if (action === "write") {
        if (!draftPath) {
          throw new Error("A knowledge path is required.");
        }
        const result = await kernel.request("knowledge.write", {
          path: draftPath,
          markdown: draftMarkdown,
          mode: "replace",
          create: true,
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Failed to save note");
        }
        selectedPath = result.path;
        statusText = result.created ? `Created ${result.path}` : `Saved ${result.path}`;
      } else if (action === "ingest") {
        if (!selectedDb) {
          throw new Error("Select a database before ingesting sources.");
        }
        const sources = parseSourceLines(ingestSources);
        const result = await kernel.request("knowledge.ingest", {
          db: selectedDb,
          sources,
          title: ingestTitle || undefined,
          summary: ingestSummary || undefined,
          mode: "inbox",
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Failed to ingest sources");
        }
        selectedPath = result.path;
        statusText = `Staged ${result.path}`;
      } else if (action === "compile") {
        if (!selectedDb) {
          throw new Error("Select a database before compiling inbox notes.");
        }
        if (!selectedPath.startsWith(`${selectedDb}/inbox/`)) {
          throw new Error("Only inbox notes can be compiled.");
        }
        const result = await kernel.request("knowledge.compile", {
          db: selectedDb,
          sourcePath: selectedPath,
          targetPath: compileTarget || undefined,
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Failed to compile inbox note");
        }
        selectedPath = result.path;
        statusText = `Compiled ${result.sourcePath} into ${result.path}`;
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
  }

  let dbs = [];
  let pages = [];
  let inbox = [];
  let selectedNote = null;
  let searchMatches = null;
  let queryResult = null;

  try {
    const listResult = await kernel.request("knowledge.db.list", { limit: 200 });
    dbs = Array.isArray(listResult?.dbs) ? listResult.dbs : [];
    if (!selectedDb && dbs.length > 0) {
      selectedDb = dbs[0].id;
    }
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
  }

  if (selectedDb) {
    try {
      const pageList = await kernel.request("knowledge.list", {
        prefix: `${selectedDb}/pages`,
        recursive: true,
        limit: 200,
      });
      pages = Array.isArray(pageList?.entries) ? pageList.entries.filter((entry) => entry.kind === "file") : [];
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
    }

    try {
      const inboxList = await kernel.request("knowledge.list", {
        prefix: `${selectedDb}/inbox`,
        recursive: true,
        limit: 200,
      });
      inbox = Array.isArray(inboxList?.entries) ? inboxList.entries.filter((entry) => entry.kind === "file") : [];
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
    }

    if (!selectedPath) {
      selectedPath = `${selectedDb}/index.md`;
    }
  }

  async function loadSelectedNote(path) {
    const readResult = await kernel.request("knowledge.read", { path });
    return readResult?.exists ? readResult : null;
  }

  if (selectedPath) {
    try {
      selectedNote = await loadSelectedNote(selectedPath);
      if (selectedNote) {
        draftPath = selectedNote.path;
        draftMarkdown = selectedNote.markdown ?? draftMarkdown;
      } else if (!url.searchParams.get("path") && pages.length > 0) {
        selectedPath = pages[0].path;
        selectedNote = await loadSelectedNote(selectedPath);
        if (selectedNote) {
          draftPath = selectedNote.path;
          draftMarkdown = selectedNote.markdown ?? draftMarkdown;
        }
      }
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
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
      errorText = errorText || (error instanceof Error ? error.message : String(error));
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
      errorText = errorText || (error instanceof Error ? error.message : String(error));
    }
  }

  return new Response(renderPage({
    routeBase,
    dbs,
    selectedDb,
    pages,
    inbox,
    selectedPath,
    selectedNote,
    searchQuery,
    searchMatches,
    queryText,
    queryResult,
    statusText,
    errorText,
    draftPath,
    draftMarkdown,
    newDbId,
    newDbTitle,
    ingestSources,
    ingestTitle,
    ingestSummary,
    compileTarget,
  }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: handleFetch };
