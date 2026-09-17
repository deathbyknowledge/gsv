import { z } from "zod";
import type { AiDecisionQuestion, ConversationMessage, KnowledgeContext, KnowledgeMention, RepoApplyOp } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import { handleConversationHistory } from "../../../kernel/conversation-handlers";
import { handleAiTextGenerate } from "../../../kernel/ai";
import { handleAiDecide } from "../../../kernel/decisions";
import { handleRepoApply, handleRepoRead, handleRepoRefs, handleRepoSearch } from "../../../kernel/repo";
import { KNOWLEDGE_MENTIONS_PROMPT, KNOWLEDGE_ENRICHMENT_PROMPT, knowledgeMatchQuestion, knowledgeValueQuestion } from "../../../prompts/knowledge-context";
import { requireCommandCapability } from "./common";

const kindSchema = z.enum(["person", "project", "concept", "place", "object"]);
const extractionSchema = z.object({ mentions: z.array(z.object({ text: z.string().min(1).max(160), kind: kindSchema })).max(8) });
const notesSchema = z.object({ notes: z.array(z.object({ id: z.string(), markdown: z.string().min(1).max(6000) })).max(8) });
const contextSchema = z.object({
  version: z.literal(1),
  source: z.object({ conversationId: z.string(), messageId: z.string(), sequence: z.number(), createdAt: z.number() }),
  repo: z.string(), enriched: z.boolean(),
  mentions: z.array(z.object({ id: z.string().regex(/^mention_[0-7]$/), text: z.string().min(1).max(160), kind: kindSchema,
    status: z.enum(["linked", "pending", "created", "uncertain"]), path: z.string().optional(),
    excerpt: z.string().optional(), confidence: z.number().optional() })),
});

/** One ordinary wiki workflow, shared by the UI, shell and agent callers. */
export async function buildWikiContext(args: string[], ctx: KernelContext, enrich: boolean): Promise<KnowledgeContext> {
  const [conversationId, sequenceArg, ...extra] = args;
  const sequence = Number(sequenceArg);
  if (!conversationId || !Number.isSafeInteger(sequence) || sequence < 1 || extra.length) {
    throw new Error(`Usage: wiki ${enrich ? "enrich" : "context"} <conversation-id> <message-sequence>`);
  }
  for (const capability of ["conversation.history", "repo.read", "repo.refs", "repo.search", "repo.apply", "ai.text.generate", "ai.decide"]) {
    requireCommandCapability(ctx, capability);
  }
  const history = await handleConversationHistory({ conversationId, beforeSequence: sequence + 1, limit: 6 }, ctx);
  const message = history.messages.find((value) => value.sequence === sequence);
  if (!message) throw new Error("The source message is unavailable");
  if (message.text.length > 24000) throw new Error("This message is too long for automatic knowledge enrichment");
  const owner = ctx.auth.getPasswdByUid(resolveCallerOwnerUid(ctx));
  if (!owner) throw new Error("Knowledge owner is unavailable");
  const repo = `${owner.username}/personal`;
  const sourceId = await digest(`${conversationId}\n${message.id}`);
  const cachePath = `.context/messages/${sourceId}.json`;
  const cached = await readText(repo, cachePath, ctx);
  let context: KnowledgeContext;
  if (cached !== null) {
    const parsed = contextSchema.safeParse(parseJson(cached));
    if (!parsed.success || parsed.data.repo !== repo || parsed.data.source.messageId !== message.id || parsed.data.source.conversationId !== conversationId || parsed.data.source.sequence !== sequence) {
      throw new Error("Saved knowledge context is invalid");
    }
    context = parsed.data;
  } else {
    context = await discover(message, history.messages, repo, ctx);
    await saveContext(context, cachePath, [], ctx);
  }
  if (!enrich || context.enriched || !context.mentions.some((mention) => mention.status === "pending")) return context;
  const pending = context.mentions.filter((mention) => mention.status === "pending");
  const generated = notesSchema.safeParse(await generateJson(KNOWLEDGE_ENRICHMENT_PROMPT, {
    message: sourceEvidence(message), conversation: history.messages.map(sourceEvidence), mentions: pending,
  }, ctx));
  if (!generated.success) throw new Error("Knowledge enrichment returned invalid notes");
  const notes = new Map(generated.data.notes.map((note) => [note.id, note.markdown]));
  const ops: Array<Extract<RepoApplyOp, { type: "put" }>> = [];
  const enriched: KnowledgeContext = { ...context, enriched: true, mentions: context.mentions.map((mention) => ({ ...mention })) };
  for (const mention of enriched.mentions) {
    if (mention.status !== "pending") continue;
    const note = notes.get(mention.id);
    if (!note) { mention.status = "uncertain"; continue; }
    const name = mention.text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || mention.kind;
    const path = `pages/${mention.kind === "person" ? "people" : `${mention.kind}s`}/${name}-${sourceId.slice(0, 10)}-${mention.id}.md`;
    mention.path = path;
    mention.status = "created";
    mention.excerpt = note;
    ops.push({ type: "put", path, content: [
      `# ${mention.text.replace(/[\r\n]/g, " ")}`, "", note, "",
      "## Source", "", "Generated from a conversation; claims retain the source's attribution and uncertainty.", "",
      `Conversation: ${conversationId}`, `Message: ${message.id}`, `Recorded: ${new Date(message.createdAt).toISOString()}`, "",
      ...message.text.split("\n").map((line) => `> ${line}`), "",
    ].join("\n") });
  }
  // Never replace an existing page, including one the person edited after discovery.
  for (const op of ops) {
    if (await readText(repo, op.path, ctx) !== null) throw new Error("A knowledge page already exists; open Memory to reconcile it");
  }
  await saveContext(enriched, cachePath, ops, ctx, context);
  return enriched;
}

async function discover(message: ConversationMessage, conversation: ConversationMessage[], repo: string, ctx: KernelContext): Promise<KnowledgeContext> {
  const context: KnowledgeContext = { version: 1, repo, enriched: false,
    source: { conversationId: message.conversationId, messageId: message.id, sequence: message.sequence, createdAt: message.createdAt }, mentions: [] };
  if (!message.text.trim()) return { ...context, enriched: true };
  const extracted = extractionSchema.safeParse(await generateJson(KNOWLEDGE_MENTIONS_PROMPT, { message: sourceEvidence(message), conversation: conversation.map(sourceEvidence) }, ctx));
  if (!extracted.success) throw new Error("Concept extraction returned invalid mentions");
  const seen = new Set<string>();
  const mentions = extracted.data.mentions.filter((mention) => {
    const key = mention.text.toLocaleLowerCase();
    if (!message.text.includes(mention.text) || seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (!mentions.length) return { ...context, enriched: true };
  const candidates = await Promise.all(mentions.map(async (mention) => {
    const search = await handleRepoSearch({ repo, query: mention.text, prefix: "pages/" }, ctx);
    const paths = [...new Set(search.matches.map((match) => match.path).filter((path) => path.endsWith(".md")))].slice(0, 4);
    const pages = await Promise.all(paths.map(async (path) => ({ path, text: (await readText(repo, path, ctx) ?? "").slice(0, 2400) })));
    return { pages, truncated: search.truncated === true };
  }));
  const questions: Record<string, AiDecisionQuestion> = {};
  for (let i = 0; i < mentions.length; i += 1) {
    if (candidates[i].pages.length) questions[`match_${i}`] = { type: "choice", instructions: knowledgeMatchQuestion(i),
      criteria: { none: "No supplied page describes this mention", ...Object.fromEntries(candidates[i].pages.map((page, j) => [`page_${j}`, `The page at mentions[${i}].candidates.pages[${j}]: ${page.path}`])) } };
    questions[`keep_${i}`] = { type: "boolean", instructions: knowledgeValueQuestion(i) };
  }
  const evaluated = await handleAiDecide({ state: { message: message.text,
    mentions: mentions.map((mention, i) => ({ ...mention, candidates: candidates[i] })) }, questions }, ctx);
  context.mentions = mentions.map((mention, i): KnowledgeMention => {
    const match = evaluated.answers[`match_${i}`];
    const keep = evaluated.answers[`keep_${i}`];
    const confidentMatch = match?.type === "choice" && match.confidence >= 0.7 ? match : null;
    const page = confidentMatch && confidentMatch.choice !== "none" ? candidates[i].pages[Number(confidentMatch.choice.slice(5))] : undefined;
    const unknown = !candidates[i].pages.length || confidentMatch?.choice === "none";
    return { ...mention, id: `mention_${i}`, status: page ? "linked" : unknown && !candidates[i].truncated && keep?.type === "boolean" && keep.probability >= 0.8 ? "pending" : "uncertain",
      ...(page ? { path: page.path, excerpt: page.text } : {}),
      ...(match?.type === "choice" ? { confidence: match.confidence } : {}),
    };
  });
  context.enriched = !context.mentions.some((mention) => mention.status === "pending");
  return context;
}

function sourceEvidence(message: ConversationMessage) {
  return { id: message.id, author: message.author, text: message.text.slice(0, 24000), createdAt: message.createdAt };
}

async function generateJson(systemPrompt: string, state: object, ctx: KernelContext): Promise<unknown> {
  ctx.requestSignal?.throwIfAborted();
  const result = await handleAiTextGenerate({ systemPrompt, messages: [{ role: "user", content: JSON.stringify(state), timestamp: Date.now() }],
    options: { maxTokens: 4096, timeoutMs: 60000 } }, { ...ctx, requestId: crypto.randomUUID() });
  if (result.message.stopReason !== "stop") throw new Error(`Knowledge generation did not complete (${result.message.stopReason})`);
  return parseJson(result.text ?? "");
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { throw new Error("Knowledge generation returned invalid JSON"); }
}

async function readText(repo: string, path: string, ctx: KernelContext, ref?: string): Promise<string | null> {
  try {
    const result = await handleRepoRead({ repo, path, ref }, ctx);
    if (result.kind !== "file" || result.isBinary || result.content === null) throw new Error("Knowledge record is not readable text");
    return result.content;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Path not found:")) return null;
    throw error;
  }
}

async function saveContext(context: KnowledgeContext, path: string, ops: Array<Extract<RepoApplyOp, { type: "put" }>>, ctx: KernelContext, previous?: KnowledgeContext): Promise<void> {
  ctx.requestSignal?.throwIfAborted();
  const head = (await handleRepoRefs({ repo: context.repo }, ctx)).heads.main;
  if (!head) throw new Error("Personal wiki has no main revision");
  const current = await readText(context.repo, path, ctx, head);
  if (previous ? current === null || JSON.stringify(contextSchema.parse(parseJson(current))) !== JSON.stringify(contextSchema.parse(previous)) : current !== null) throw new Error("Knowledge context changed; retry from the saved record");
  for (const op of ops) {
    if (await readText(context.repo, op.path, ctx, head) !== null) throw new Error("A knowledge page already exists");
  }
  ctx.requestSignal?.throwIfAborted();
  await handleRepoApply({ repo: context.repo, expectedHead: head, message: ops.length ? "enrich conversation concepts" : "index conversation concepts",
    ops: [...ops, { type: "put", path, content: JSON.stringify(contextSchema.parse(context)) }] }, ctx);
}

async function digest(text: string): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
