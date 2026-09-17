import { z } from "zod";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { KnowledgeContext, AiDecideResult } from "@humansandmachines/gsv/protocol";
import type { ChatTranscriptRow } from "../chat/domain/transcript";
import type { ConsoleProcess } from "../../domain/system/consoleModels";
import { workspaceSelectionQuestions } from "../../../../../workers/gateway/src/prompts/workspace-selection";

export type WorkspaceObservation = {
  pid: string;
  conversationId: string;
  sequence: number;
  message: ChatTranscriptRow;
  files: Array<{ target: string; path: string }>;
};

export type WorkspaceSource =
  | { id: string; kind: "conversation"; title: string }
  | { id: string; kind: "message"; title: string; row: ChatTranscriptRow; pid: string }
  | { id: string; kind: "process"; title: string; process: ConsoleProcess }
  | { id: string; kind: "memory"; title: string; repo: string; path: string; excerpt?: string }
  | { id: string; kind: "file"; title: string; target: string; path: string }
  | { id: string; kind: "media"; title: string; media: NonNullable<ChatTranscriptRow["media"]>[number]; pid: string };

export type WorkspaceLayout = "focus" | "split" | "lead" | "grid";
export type WorkspaceComposition = { layout: WorkspaceLayout; sources: string[] };

const contextSchema = z.object({
  version: z.literal(1), repo: z.string(), enriched: z.boolean(),
  source: z.object({ conversationId: z.string(), messageId: z.string(), sequence: z.number(), createdAt: z.number() }),
  mentions: z.array(z.object({ id: z.string(), text: z.string(), kind: z.enum(["person", "project", "concept", "place", "object"]),
    status: z.enum(["linked", "pending", "created", "uncertain"]), path: z.string().optional(), excerpt: z.string().optional(), confidence: z.number().optional() })),
});

function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

export async function loadKnowledgeContext(client: Pick<GSVClient, "request">, observation: WorkspaceObservation, enrich: boolean, signal: AbortSignal): Promise<KnowledgeContext> {
  const response = await client.request("shell.exec", { target: "gsv", timeout: 120000,
    input: `wiki ${enrich ? "enrich" : "context"} ${quote(observation.conversationId)} ${observation.sequence}` }, { signal });
  await response.body?.stream.cancel();
  const result = response.data;
  if (result.status !== "completed" || result.exitCode !== 0) {
    throw new Error(result.output || "Knowledge context could not be loaded");
  }
  const parsed = contextSchema.parse(JSON.parse(result.output));
  if (parsed.source.conversationId !== observation.conversationId || parsed.source.sequence !== observation.sequence) {
    throw new Error("Knowledge context belongs to another message");
  }
  return parsed;
}

export function workspaceSources(observation: WorkspaceObservation | null, knowledge: KnowledgeContext | null, processes: ConsoleProcess[]): WorkspaceSource[] {
  const sources: WorkspaceSource[] = [{ id: "conversation", kind: "conversation", title: "Conversation" }];
  if (!observation) return sources;
  sources.push({ id: "message", kind: "message", title: "Latest message", row: observation.message, pid: observation.pid });
  for (const process of processes.filter((value) => value.pid === observation.pid || value.activeRunId || value.state === "waiting_hil").slice(0, 4)) {
    sources.push({ id: `process:${process.pid}`, kind: "process", title: process.personal ? "Ship process" : process.label || process.pid, process });
  }
  for (const file of observation.files.slice(-4)) sources.push({ id: `file:${file.target}:${file.path}`, kind: "file", title: file.path.split("/").at(-1) || file.path, ...file });
  if (knowledge?.source.conversationId === observation.conversationId && knowledge.source.sequence === observation.sequence) {
    for (const mention of knowledge.mentions) if (mention.path) sources.push({ id: `memory:${knowledge.repo}:${mention.path}`, kind: "memory", title: mention.text, repo: knowledge.repo, path: mention.path, excerpt: mention.excerpt });
  }
  for (const [index, media] of (observation.message.media ?? []).slice(0, 4).entries()) sources.push({ id: `media:${observation.message.id}:${index}`, kind: "media", title: `Attachment ${index + 1}`, media, pid: observation.pid });
  return [...new Map(sources.map((source) => [source.id, source])).values()];
}

export async function chooseWorkspace(client: Pick<GSVClient, "request">, sources: WorkspaceSource[], observation: WorkspaceObservation, pinned: string[], current: WorkspaceComposition, signal: AbortSignal): Promise<WorkspaceComposition> {
  if (sources.length < 2) return { layout: "focus", sources: ["conversation"] };
  const response = await client.request("ai.decide", {
    state: {
      message: observation.message.text.slice(0, 6000),
      viewport: { width: window.innerWidth, height: window.innerHeight }, pinned, current,
      sources: sources.map((source) => ({ id: source.id, title: source.title, kind: source.kind,
        detail: source.kind === "memory" ? source.excerpt?.slice(0, 800) ?? ""
          : source.kind === "process" ? `${source.process.state}, ${source.process.activeRunId ? "running" : "idle"}`
          : source.kind === "file" ? `${source.target}:${source.path}` : "" })),
    }, questions: workspaceSelectionQuestions(sources),
  }, { signal });
  await response.body?.stream.cancel();
  return composeWorkspace(response.data, sources, pinned);
}

/** Keep the provider's choices within the candidate set and retain every pinned view. */
export function composeWorkspace(result: AiDecideResult, sources: WorkspaceSource[], pinned: string[]): WorkspaceComposition {
  const primary = result.answers.primary;
  const layoutAnswer = result.answers.layout;
  const layout: WorkspaceLayout = layoutAnswer?.type === "choice" && ["focus", "split", "lead", "grid"].includes(layoutAnswer.choice)
    ? layoutAnswer.choice as WorkspaceLayout : "lead";
  const available = new Set(sources.map((source) => source.id));
  const lead = primary?.type === "choice" && available.has(primary.choice) ? primary.choice : sources[0]?.id;
  if (!lead) return { layout: "focus", sources: [] };
  const ranked = sources.map((source, i) => {
    const answer = result.answers[`relevance_${i}`];
    return { id: source.id, score: answer?.type === "score" ? answer.score : 0 };
  }).filter((source) => source.score >= 1.5).sort((left, right) => right.score - left.score);
  const count = layout === "focus" ? 1 : layout === "split" ? 2 : 4;
  const keep = [...new Set(pinned.filter((id) => available.has(id)))];
  const selected = [...new Set([lead, ...keep, ...ranked.map((source) => source.id)])].slice(0, Math.max(count, keep.length + (keep.includes(lead) ? 0 : 1)));
  return { layout: selected.length === 1 ? "focus" : layout === "focus" ? "lead" : layout, sources: selected };
}
