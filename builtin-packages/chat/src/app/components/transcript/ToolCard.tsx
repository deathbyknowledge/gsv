import type { HilRequest, ToolRow } from "../../types";
import {
  asNumber,
  asRecord,
  asString,
  describeToolCard,
  inferToolSyscall,
  normalizeToolOutput,
  prettyJson,
  truncateBlock,
} from "../../view-helpers";

export function ToolCard({ row }: { row: ToolRow }) {
  const syscall = inferToolSyscall(row.toolName, row.syscall);
  const card = describeToolCard(row.toolName, row.args, syscall);
  const ok = row.kind === "toolCall" ? false : row.ok !== false;
  const statusClass = row.kind === "toolCall" ? "is-pending" : ok ? "is-ok" : "is-error";
  return (
    <article class={`tool-card ${statusClass}`}>
      <div class="tool-card-head">
        <div>
          <h3>{card.title}</h3>
          {card.subtitle ? <p>{card.subtitle}</p> : null}
        </div>
        <span class={`tool-status ${statusClass}`}>
          {row.kind === "toolCall" ? "Running" : ok ? "Done" : "Error"}
          <span>{card.target}</span>
        </span>
      </div>
      <div class="tool-preview">
        {row.kind === "toolCall"
          ? <p>Waiting for result.</p>
          : <ToolPreview row={row} syscall={syscall} />}
      </div>
      <details class="tool-details">
        <summary>{row.kind === "toolCall" ? "Input" : "Details"}</summary>
        <ToolDetails row={row} syscall={syscall} />
      </details>
    </article>
  );
}

function ToolPreview({ row, syscall }: { row: ToolRow; syscall: string | null }) {
  const normalized = normalizeToolOutput(row.output);
  const record = asRecord(normalized);
  if (row.ok === false || record?.ok === false) {
    return <p class="tool-error">{row.error || asString(record?.error) || "Tool call failed."}</p>;
  }
  if (isCodeModeTool(row.toolName, syscall)) {
    return <CodeModePreview row={row} output={normalized} />;
  }
  if (row.toolName === "Shell" || syscall === "shell.exec") {
    const stdout = asString(record?.stdout);
    const stderr = asString(record?.stderr);
    if (stdout?.trim()) return <pre>{truncateBlock(stdout, 800)}</pre>;
    if (stderr?.trim()) return <pre>{truncateBlock(stderr, 800)}</pre>;
    return <p>Command completed.</p>;
  }
  if (row.toolName === "Read" || syscall === "fs.read") {
    if (typeof record?.content === "string") return <pre>{truncateBlock(record.content, 800)}</pre>;
    const directories = Array.isArray(record?.directories) ? record.directories : [];
    const files = Array.isArray(record?.files) ? record.files : [];
    if (directories.length || files.length) {
      return <p>Listed {directories.length} dirs and {files.length} files.</p>;
    }
    return <p>Read completed.</p>;
  }
  if (row.toolName === "Search" || syscall === "fs.search") {
    const matches = Array.isArray(record?.matches) ? record.matches : [];
    const count = asNumber(record?.count) ?? matches.length;
    return <p>{count} matches.</p>;
  }
  if (typeof normalized === "string") {
    return <pre>{truncateBlock(normalized, 800)}</pre>;
  }
  return <pre>{truncateBlock(prettyJson(normalized), 800)}</pre>;
}

export function ToolDetails({ row, syscall }: { row: ToolRow; syscall: string | null }) {
  const normalized = normalizeToolOutput(row.output);
  if (isCodeModeTool(row.toolName, syscall)) {
    return <CodeModeDetails row={row} syscall={syscall} output={normalized} />;
  }
  return (
    <div class="tool-detail-stack">
      <MetaGrid rows={[["call", row.callId], ["syscall", syscall || ""]]} />
      <pre>{truncateBlock(prettyJson(row.args), 2400)}</pre>
      {row.kind === "toolResult" && normalized !== undefined ? (
        <pre>{truncateBlock(typeof normalized === "string" ? normalized : prettyJson(normalized), 4000)}</pre>
      ) : null}
    </div>
  );
}

function isCodeModeTool(toolName: string, syscall: string | null): boolean {
  return toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run";
}

export function isHiddenInternalToolRow(row: ToolRow, pendingHil: HilRequest | null): boolean {
  const syscall = inferToolSyscall(row.toolName, row.syscall);
  return syscall === "sys.mcp.call" && row.callId !== pendingHil?.callId;
}

function CodeModePreview({ row, output }: { row: ToolRow; output: unknown }) {
  if (row.kind === "toolCall") {
    return <p>Executing process-local script.</p>;
  }
  const record = asRecord(output);
  const status = asString(record?.status);
  const logs = normalizeCodeModeLogs(record?.logs);
  if (status === "failed") {
    return (
      <div class="codemode-preview">
        <p class="tool-error">{asString(record?.error) || row.error || "CodeMode script failed."}</p>
        {logs.length > 0 ? <p>{logs.length} log {logs.length === 1 ? "line" : "lines"} captured.</p> : null}
      </div>
    );
  }
  if (status === "completed") {
    const result = record?.result;
    return (
      <div class="codemode-preview">
        <p>{describeCodeModeResult(result)}</p>
        {logs.length > 0 ? <p>{logs.length} log {logs.length === 1 ? "line" : "lines"} captured.</p> : null}
        {renderCodeModePreviewValue(result)}
      </div>
    );
  }
  return <p>CodeMode completed.</p>;
}

function CodeModeDetails({ row, syscall, output }: { row: ToolRow; syscall: string | null; output: unknown }) {
  const args = asRecord(row.args);
  const code = asString(args?.code);
  const record = asRecord(output);
  const status = asString(record?.status);
  const logs = normalizeCodeModeLogs(record?.logs);
  return (
    <div class="tool-detail-stack codemode-details">
      <MetaGrid rows={[["call", row.callId], ["syscall", syscall || ""], ["status", status || (row.kind === "toolCall" ? "running" : "")]]} />
      {code ? (
        <section>
          <h4>Script</h4>
          <pre>{truncateBlock(code, 4000)}</pre>
        </section>
      ) : null}
      {logs.length > 0 ? (
        <section>
          <h4>Logs</h4>
          <pre>{truncateBlock(logs.join("\n"), 4000)}</pre>
        </section>
      ) : null}
      {status === "failed" ? (
        <section>
          <h4>Error</h4>
          <pre>{truncateBlock(asString(record?.error) || row.error || "CodeMode script failed.", 2000)}</pre>
        </section>
      ) : null}
      {status === "completed" ? (
        <section>
          <h4>Result</h4>
          {renderCodeModeDetailsValue(record?.result)}
        </section>
      ) : null}
    </div>
  );
}

function normalizeCodeModeLogs(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => typeof item === "string" ? item : prettyJson(item))
    .filter((item) => item.trim().length > 0);
}

function describeCodeModeResult(value: unknown): string {
  if (value === null || value === undefined) return "Completed with no return value.";
  if (typeof value === "string") return value.trim() ? "Returned text." : "Returned empty text.";
  if (typeof value === "number" || typeof value === "boolean") return `Returned ${String(value)}.`;
  if (Array.isArray(value)) return `Returned ${value.length} ${value.length === 1 ? "item" : "items"}.`;
  const record = asRecord(value);
  if (record) {
    const summary = asString(record.summary) || asString(record.message) || asString(record.output);
    if (summary) return truncateBlock(summary, 180);
    const keys = Object.keys(record);
    return keys.length > 0 ? `Returned object with ${keys.length} ${keys.length === 1 ? "field" : "fields"}: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", ..." : ""}.` : "Returned an empty object.";
  }
  return "Completed.";
}

function renderCodeModePreviewValue(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return <pre>{truncateBlock(value, 800)}</pre>;
  }
  const record = asRecord(value);
  const stdout = asString(record?.stdout);
  const stderr = asString(record?.stderr);
  if (stdout?.trim()) return <pre>{truncateBlock(stdout, 800)}</pre>;
  if (stderr?.trim()) return <pre>{truncateBlock(stderr, 800)}</pre>;
  return null;
}

function renderCodeModeDetailsValue(value: unknown) {
  if (value === null || value === undefined) return <p>No return value.</p>;
  if (typeof value === "string") return value.trim() ? <pre>{truncateBlock(value, 4000)}</pre> : <p>Empty text.</p>;
  if (typeof value === "number" || typeof value === "boolean") return <p>{String(value)}</p>;
  if (Array.isArray(value)) {
    return value.length === 0 ? <p>Empty array.</p> : <pre>{truncateBlock(prettyJson(value), 4000)}</pre>;
  }
  return <pre>{truncateBlock(prettyJson(value), 4000)}</pre>;
}

function MetaGrid({ rows }: { rows: Array<[string, string | number | null | undefined]> }) {
  return (
    <div class="meta-grid">
      {rows.filter((row) => row[1] !== null && row[1] !== undefined && String(row[1]).length > 0).map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <span>{String(value)}</span>
        </div>
      ))}
    </div>
  );
}
