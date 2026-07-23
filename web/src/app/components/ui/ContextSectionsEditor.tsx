import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useState } from "preact/hooks";
import { Button } from "./Button";
import { ConfirmModal } from "./ConfirmModal";
import { TextInput } from "./TextInput";
import "./ContextSectionsEditor.css";

/** One markdown context section (structurally identical to AgentEditorFile). */
export interface ContextSection {
  label: string;
  name?: string;
  origName?: string;
  content: string;
  orig?: string;
}

export interface ContextSectionsEditorProps {
  files: readonly ContextSection[];
  onChange: (files: ContextSection[]) => void;
  /** Controlled active-section index (host owns it so per-section RESET works). */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  readOnly?: boolean;
  /** Right-aligned controls in the action row (e.g. host SAVE / RESET / status).
   *  Rendered next to the section's own DELETE affordance. */
  actions?: ComponentChildren;
}

export function fileLabel(file: ContextSection, index: number): string {
  return file.label.trim() || file.name?.trim() || `SECTION ${index + 1}`;
}

function fileName(file: ContextSection, index: number): string {
  const explicit = file.name?.trim();
  if (explicit) {
    return explicit;
  }
  const label = file.label.trim();
  if (label.toUpperCase() === "PERSONA") {
    return "05-persona.md";
  }
  const base = label.toLowerCase().replace(/\.md$/i, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || `file-${index + 1}`}.md`;
}

function sectionSlug(label: string, index: number): string {
  const slug = label
    .trim()
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `section-${index + 1}`;
}

function contextOrderPrefix(file: ContextSection, index: number): string {
  const existing = (file.name ?? file.origName ?? "").match(/^(\d+)-/);
  if (existing) {
    return `${existing[1]}-`;
  }
  if (fileLabel(file, index).toUpperCase() === "PERSONA") {
    return "05-";
  }
  return `${String((index + 1) * 10).padStart(2, "0")}-`;
}

function contextFileNameForSection(
  label: string,
  index: number,
  file: ContextSection,
  files: readonly ContextSection[],
): string {
  const prefix = contextOrderPrefix(file, index);
  const baseName = `${prefix}${sectionSlug(label, index)}.md`;
  const used = new Set(
    files
      .filter((candidate) => candidate !== file)
      .map((candidate, candidateIndex) => fileName(candidate, candidateIndex).toLowerCase()),
  );
  if (!used.has(baseName.toLowerCase())) {
    return baseName;
  }
  let suffix = 2;
  while (used.has(`${prefix}${sectionSlug(label, index)}-${suffix}.md`.toLowerCase())) {
    suffix += 1;
  }
  return `${prefix}${sectionSlug(label, index)}-${suffix}.md`;
}

function nextUntitledSection(files: readonly ContextSection[]): { label: string; name: string } {
  const names = new Set(files.map((file, index) => fileName(file, index).toLowerCase()));
  let index = 1;
  while (true) {
    const label = index === 1 ? "Untitled" : `Untitled ${index}`;
    const file: ContextSection = { label, content: "" };
    const name = contextFileNameForSection(label, files.length, file, files);
    if (!names.has(name.toLowerCase())) {
      return { label, name };
    }
    index += 1;
  }
}

/** ContextSectionsEditor — the markdown context-sections editing surface shared
 *  by the AgentEditor CONTEXT tab and the CREW defaults editor: a row of file-tab
 *  sections + NEW SECTION, the active section's name + content editor, a
 *  per-section DELETE (with confirm), and an `actions` slot for the host's own
 *  SAVE/RESET/status. Controlled via `files`/`onChange` and `activeIndex`. */
export function ContextSectionsEditor({
  files,
  onChange,
  activeIndex,
  onActiveIndexChange,
  readOnly = false,
  actions,
}: ContextSectionsEditorProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);

  const hasSections = files.length > 0;
  const fileIdx = Math.max(0, Math.min(activeIndex, files.length - 1));
  const curFile = files[fileIdx] || files[0] || { label: "", content: "" };

  const addSection = () => {
    if (readOnly) return;
    const next = nextUntitledSection(files);
    onChange([...files, { label: next.label, name: next.name, content: "# Untitled\n\n" }]);
    onActiveIndexChange(files.length);
  };

  const renameSection = (value: string) => {
    if (readOnly) return;
    onChange(files.map((f, i) => (
      i === fileIdx
        ? { ...f, label: value, name: contextFileNameForSection(value, i, f, files) }
        : f
    )));
  };

  const setContent = (value: string) => {
    if (readOnly) return;
    onChange(files.map((f, i) => (i === fileIdx ? { ...f, content: value } : f)));
  };

  const confirmDelete = () => {
    if (readOnly) return;
    const next = files.filter((_, i) => i !== fileIdx);
    onChange(next);
    onActiveIndexChange(Math.max(0, Math.min(fileIdx, next.length - 1)));
    setDeleteOpen(false);
  };

  const delName = hasSections ? fileLabel(curFile, fileIdx) : "context section";

  return (
    <div class="gsv-cse">
      {/* section tabs */}
      <div class="gsv-cse-tabs">
        {files.map((f, i) => (
          <button
            key={`${f.origName ?? f.name ?? f.label}-${i}`}
            type="button"
            class="gsv-cse-file-tab"
            onClick={() => onActiveIndexChange(i)}
          >
            <svg width="34" height="30" viewBox="0 0 16 14" shape-rendering="crispEdges" fill={i === fileIdx ? "var(--accent-bright)" : "var(--border-raised)"}>
              <rect x="1" y="2" width="6" height="2" />
              <rect x="1" y="4" width="14" height="9" />
            </svg>
            <span class="gsv-sublabel" style={`letter-spacing:.1em;color:${i === fileIdx ? "var(--text)" : "var(--text-muted)"};line-height:1.35;`}>
              {fileLabel(f, i)}
            </span>
          </button>
        ))}
        <button
          type="button"
          disabled={readOnly}
          onClick={readOnly ? undefined : addSection}
          class={`gsv-cse-file-tab gsv-cse-newfile${readOnly ? " is-disabled" : ""}`}
        >
          <svg width="34" height="30" viewBox="0 0 16 14" shape-rendering="crispEdges" fill="none" stroke="var(--dashed)" stroke-width="1">
            <path d="M1.5 3.5 H6.5 V4.5" />
            <rect x="1.5" y="4.5" width="13" height="8" />
          </svg>
          <span class="gsv-sublabel" style="letter-spacing:.1em;color:var(--accent);border-bottom:1px solid var(--accent);padding-bottom:1px;">NEW SECTION</span>
        </button>
      </div>

      {hasSections ? (
        <>
          <div style="max-width:520px;margin-bottom:16px;">
            <TextInput
              value={fileLabel(curFile, fileIdx)}
              onChange={renameSection}
              placeholder="Operating notes"
              size="medium"
              label="SECTION NAME"
              readonly={readOnly}
            />
          </div>

          <textarea
            class="gsv-ed gsv-cse-editor"
            value={curFile.content}
            onInput={(event) => setContent((event.target as HTMLTextAreaElement).value)}
            spellcheck={false}
            readOnly={readOnly}
          />
        </>
      ) : (
        <div class="gsv-cse-empty-context">
          <strong>NO CONTEXT SECTIONS</strong>
        </div>
      )}

      <div class="gsv-cse-actions">
        <Button variant="dangerGhost" label="DELETE" onClick={() => setDeleteOpen(true)} disabled={readOnly || !hasSections} />
        <span style="flex:1;" />
        {actions}
      </div>

      {/* DELETE CONFIRM MODAL — portaled to <body> so an ancestor
          container-type doesn't trap its viewport-fixed scrim. */}
      {deleteOpen ? createPortal(
        <div class="gsv-cse-modal-scrim" onClick={() => setDeleteOpen(false)}>
          <div class="gsv-cse-modal-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="CONFIRM DELETE"
              message={`Are you sure you want to delete "${delName}"?`}
              note="This file is removed from the agent -- it can't be recovered."
              onCancel={() => setDeleteOpen(false)}
              onConfirm={confirmDelete}
            />
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
