import {
  compileInboxNote as legacyCompileInboxNote,
  createDatabase as legacyCreateDatabase,
  getPreview as legacyGetPreview,
  handleAppSignal,
  ingestSourcesToInbox as legacyIngestSourcesToInbox,
  loadState as legacyLoadState,
  startBuildFromDirectory as legacyStartBuildFromDirectory,
  writePage as legacyWritePage,
} from "./legacy";
import type {
  BuildStartArgs,
  IngestSourceArgs,
  WikiLoadArgs,
  WikiMutationResult,
  WikiPreviewPayload,
  WikiPreviewRequest,
  WikiWorkspaceState,
} from "../app/types";

export { handleAppSignal };

export async function loadWorkspace(kernel: any, args: WikiLoadArgs): Promise<WikiWorkspaceState> {
  return legacyLoadState(kernel, args) as Promise<WikiWorkspaceState>;
}

export async function previewContent(kernel: any, args: WikiPreviewRequest): Promise<WikiPreviewPayload> {
  return legacyGetPreview(kernel, args) as Promise<WikiPreviewPayload>;
}

export async function createDatabase(kernel: any, args: { dbId: string; dbTitle?: string }): Promise<WikiMutationResult> {
  return legacyCreateDatabase(kernel, args) as Promise<WikiMutationResult>;
}

export async function savePage(kernel: any, args: { db: string; path: string; markdown: string }): Promise<WikiMutationResult> {
  return legacyWritePage(kernel, args) as Promise<WikiMutationResult>;
}

export async function ingestSource(kernel: any, args: IngestSourceArgs): Promise<WikiMutationResult> {
  const target = String(args.sourceTarget || "gsv").trim() || "gsv";
  const sourcePath = String(args.sourcePath || "").trim();
  if (!sourcePath) {
    throw new Error("A source path is required.");
  }
  const title = String(args.sourceTitle || "").trim();
  const summary = String(args.summary || "").trim();
  const sourceSpec = `${target}:${sourcePath}${title ? `::${title}` : ""}`;
  return legacyIngestSourcesToInbox(kernel, {
    db: args.db,
    title: title || undefined,
    summary: summary || undefined,
    sources: sourceSpec,
  }) as Promise<WikiMutationResult>;
}

export async function compileInboxNote(kernel: any, args: { db: string; sourcePath: string; targetPath?: string }): Promise<WikiMutationResult> {
  return legacyCompileInboxNote(kernel, args) as Promise<WikiMutationResult>;
}

export async function startBuild(kernel: any, args: BuildStartArgs): Promise<WikiMutationResult> {
  return legacyStartBuildFromDirectory(kernel, {
    buildTarget: args.sourceTarget,
    buildSourcePath: args.sourcePath,
    buildDbId: args.dbId,
    buildDbTitle: args.dbTitle,
  }) as Promise<WikiMutationResult>;
}
