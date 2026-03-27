/**
 * Process DO — the "smart process" that runs an agent loop.
 *
 * All mutable state (messages, tool calls, metadata) is managed by
 * ProcessStore (SQLite-backed). Communicates with the kernel
 * exclusively via recvFrame RPC in both directions.
 *
 * Agent loop: user message → LLM call → tool dispatch → collect results →
 * LLM call → ... → final text → chat.complete signal.
 * Each "turn" is scheduled via this.schedule() to avoid subrequest limits.
 */

import { Agent as Host } from "agents";
import type {
  Frame,
  RequestFrame,
  ResponseFrame,
  ResponseOkFrame,
  ResponseErrFrame,
  SignalFrame,
} from "../protocol/frames";
import type { ResultOf, SyscallName, ToolDefinition } from "../syscalls";
import type { ProcessIdentity } from "../syscalls/system";
import type {
  AiConfigResult,
  AiContextProfile,
  AiToolsDevice,
  AiToolsResult,
} from "../syscalls/ai";
import type {
  ProcSendResult,
  ProcHistoryResult,
  ProcHistoryMessage,
  ProcResetResult,
  ProcKillResult,
} from "../syscalls/proc";
import type {
  AssistantMessage,
  TextContent,
  ToolCall,
  Context,
  Tool,
} from "@mariozechner/pi-ai";
import { createGenerationService } from "../inference/service";
import {
  buildCheckpointCommitMessageContext,
  buildCheckpointSummaryContext,
  buildCheckpointTranscript,
  normalizeCheckpointCommitMessage,
  normalizeCheckpointSummary,
} from "./checkpoint";
import { ProcessStore, type MessageRecord } from "./store";
import { assembleSystemPrompt } from "./context";
import { sendFrameToKernel } from "../shared/utils";
import { TOOL_TO_SYSCALL, SYSCALL_TOOL_NAMES } from "../syscalls/constants";
import { RipgitClient } from "../fs/ripgit/client";
import { workspaceRepoRef } from "../fs/ripgit/repos";

type RunState = {
  runId: string;
  queued: boolean;
  config?: AiConfigResult;
  tools?: ToolDefinition[];
  systemPrompt?: string;
};

const CHECKPOINTED_MESSAGE_COUNT_KEY = "checkpointedMessageCount";
const TEXT_ENCODER = new TextEncoder();

export class Process extends Host<Env> {
  private readonly store: ProcessStore;
  private readonly generation = createGenerationService();
  private readonly ripgit: RipgitClient | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new ProcessStore(ctx.storage.sql);
    this.store.init();
    this.ripgit = env.RIPGIT
      ? new RipgitClient(env.RIPGIT, env.RIPGIT_INTERNAL_KEY ?? null)
      : null;
  }

  private get currentRun(): RunState | null {
    const raw = this.store.getValue("currentRun");
    if (!raw) return null;
    return JSON.parse(raw);
  }

  private set currentRun(state: RunState | null) {
    if (state) this.store.setValue("currentRun", JSON.stringify(state));
    else this.store.deleteValue("currentRun");
  }

  get pid(): string {
    const pid = this.store.getValue("pid");
    if (!pid) throw new Error("Process not initialized — pid missing");
    return pid;
  }

  get identity(): ProcessIdentity {
    const raw = this.store.getValue("identity");
    if (!raw) throw new Error("Process not initialized — identity missing");
    return JSON.parse(raw);
  }

  get profile(): AiContextProfile {
    const raw = this.store.getValue("profile");
    if (raw === "init" || raw === "task" || raw === "cron" || raw === "mcp" || raw === "app") {
      return raw;
    }
    return "task";
  }

  get initialized(): boolean {
    return this.store.getValue("pid") !== null;
  }

  /**
   * Single entry point — called by the Kernel to deliver frames.
   */
  async recvFrame(frame: Frame) {
    switch (frame.type) {
      case "req":
        return this.handleReq(frame);
      case "res":
        await this.handleRes(frame);
        return null;
      case "sig":
        await this.handleSig(frame);
        return null;
      default:
        return null;
    }
  }

  private async handleRes(frame: ResponseFrame): Promise<void> {
    const pending = this.store.getPending(frame.id);
    if (!pending) {
      console.warn(
        `[Process] Unknown or already resolved tool call: ${frame.id}`,
      );
      return;
    }

    if (frame.ok) {
      this.store.resolve(frame.id, frame.data ?? null);
    } else {
      this.store.fail(frame.id, frame.error.message);
    }

    if (this.store.isRunResolved(pending.runId)) {
      await this.continueAgentLoop(pending.runId);
    }
  }

  /**
   * Handle a request frame from the kernel.
   * proc.send, proc.history, proc.reset, proc.kill are delivered here.
   */
  private async handleReq(frame: RequestFrame): Promise<ResponseFrame | null> {
    try {
      let data: ResultOf<SyscallName>;

      switch (frame.call) {
        case "proc.setidentity": {
          const idArgs = frame.args as unknown as {
            pid: string;
            identity: ProcessIdentity;
            profile: AiContextProfile;
          };
          this.store.setValue("pid", idArgs.pid);
          this.store.setValue("identity", JSON.stringify(idArgs.identity));
          this.store.setValue("profile", idArgs.profile);
          data = { ok: true };
          break;
        }
        case "proc.send":
          data = await this.handleProcSend(
            frame.args as { pid?: string; message: string },
          );
          break;
        case "proc.history":
          data = this.handleProcHistory(
            frame.args as { pid?: string; limit?: number; offset?: number },
          );
          break;
        case "proc.reset":
          data = await this.handleProcReset();
          break;
        case "proc.kill":
          data = await this.handleProcKill(
            frame.args as { pid?: string; archive?: boolean },
          );
          break;
        default:
          return {
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: 400,
              message: `Unknown process command: ${(frame as { call: string }).call}`,
            },
          };
      }

      return { type: "res", id: frame.id, ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: 500, message },
      };
    }
  }

  private async handleProcSend(args: {
    pid?: string;
    message: string;
  }): Promise<ProcSendResult> {
    const runId = crypto.randomUUID();

    if (this.currentRun) {
      this.store.enqueue(runId, args.message);
      return { ok: true, status: "started", runId, queued: true };
    }

    this.store.appendMessage("user", args.message);
    this.currentRun = { runId, queued: false };
    this.scheduleTick(runId);

    return { ok: true, status: "started", runId };
  }

  private handleProcHistory(args: {
    pid?: string;
    limit?: number;
    offset?: number;
  }): ProcHistoryResult {
    const pid = this.pid;
    const total = this.store.messageCount();
    const records = this.store.getMessages({
      limit: args.limit,
      offset: args.offset,
    });

    const messages: ProcHistoryMessage[] = records.map((r) => {
      if (r.role === "toolResult") {
        let meta: { toolName?: string; isError?: boolean } = {};
        if (r.toolCalls) {
          try {
            meta = JSON.parse(r.toolCalls) as { toolName?: string; isError?: boolean };
          } catch {
            meta = {};
          }
        }

        return {
          role: r.role,
          content: {
            toolName: meta.toolName ?? "unknown",
            isError: meta.isError ?? false,
            toolCallId: r.toolCallId ?? null,
            output: r.content,
          },
          timestamp: r.createdAt,
        };
      }

      if (r.role === "assistant" && r.toolCalls) {
        let toolCalls: unknown = [];
        try {
          toolCalls = JSON.parse(r.toolCalls);
        } catch {
          toolCalls = [];
        }

        return {
          role: r.role,
          content: {
            text: r.content,
            toolCalls,
          },
          timestamp: r.createdAt,
        };
      }

      return {
        role: r.role,
        content: r.content,
        timestamp: r.createdAt,
      };
    });

    return {
      ok: true,
      pid,
      messages,
      messageCount: total,
      truncated: (args.offset ?? 0) + messages.length < total,
    };
  }

  private async handleProcReset(): Promise<ProcResetResult> {
    const pid = this.pid;
    const count = this.store.messageCount();
    await this.checkpointWorkspace("proc.reset");
    this.resetExecutionState();
    this.store.setValue(CHECKPOINTED_MESSAGE_COUNT_KEY, "0");

    if (count > 0) {
      const archiveId = crypto.randomUUID();
      await this.archiveMessages(pid, archiveId);
      this.store.clearMessages();

      return {
        ok: true,
        pid,
        archivedMessages: count,
        archivedTo: `/var/sessions/${this.identity.username}/${pid}/${archiveId}.jsonl.gz`,
      };
    }

    return { ok: true, pid, archivedMessages: 0 };
  }

  private async handleProcKill(args: {
    pid?: string;
    archive?: boolean;
  }): Promise<ProcKillResult> {
    const pid = this.pid;
    await this.checkpointWorkspace("proc.kill");
    this.resetExecutionState();
    this.store.setValue(CHECKPOINTED_MESSAGE_COUNT_KEY, "0");

    let archivedTo: string | null = null;

    if (args.archive !== false) {
      const archiveId = crypto.randomUUID();
      archivedTo = await this.archiveMessages(pid, archiveId);
    }

    // A killed process should restart with a clean conversation and no queued work.
    this.store.clearMessages();

    return {
      ok: true,
      pid,
      archivedTo: archivedTo ?? undefined,
    };
  }

  private resetExecutionState(): void {
    this.currentRun = null;
    this.store.clearPendingToolCalls();
    this.store.clearQueue();
  }

  private async handleSig(frame: SignalFrame): Promise<void> {
    switch (frame.signal) {
      case "identity.changed": {
        const identity = (frame.payload as { identity: ProcessIdentity })
          ?.identity;
        if (identity) {
          this.store.setValue("identity", JSON.stringify(identity));
        }
        break;
      }
      default:
        console.log(`[Process] Unknown signal: ${frame.signal}`);
        break;
    }
  }
  /**
   * Schedule the next agent loop tick using the DO scheduler.
   * Each tick resets the subrequest counter.
   */
  private scheduleTick(runId: string): void {
    const next = new Date(Date.now() + 10);
    this.schedule(next, "tick", runId);
  }

  async tick(runId: string): Promise<void> {
    await this.continueAgentLoop(runId);
  }

  private async continueAgentLoop(runId: string): Promise<void> {
    const run = this.currentRun;
    if (!run || run.runId !== runId) {
      console.warn(`[Process] Stale tick for run ${runId}, ignoring`);
      return;
    }

    // Step 1: Collect resolved tool results
    const toolResults = this.store.getResults(runId);
    const hadPendingToolCalls = toolResults.length > 0;

    if (hadPendingToolCalls) {
      for (const result of toolResults) {
        const content =
          result.status === "error"
            ? `Error: ${result.error}`
            : typeof result.result === "string"
              ? result.result
              : JSON.stringify(result.result ?? null);

        this.store.appendToolResult(
          result.id,
          result.call,
          content,
          result.status === "error",
        );

        await this.sendSignal("chat.tool_result", {
          name: SYSCALL_TOOL_NAMES[result.call] ?? result.call,
          syscall: result.call,
          callId: result.id,
          ok: result.status === "completed",
          output: result.status === "completed" ? result.result : undefined,
          error: result.status === "error" ? result.error : undefined,
          pid: this.pid,
          runId,
        });
      }
      this.store.clearRun(runId);
    }

    // Step 2: Inject queued messages at tool-result boundary
    if (hadPendingToolCalls) {
      const queued = this.store.drainQueue();
      for (const qm of queued) {
        this.store.appendMessage("user", qm.message);
      }
      if (queued.length > 0) {
        console.log(
          `[Process] Injected ${queued.length} queued message(s) at tool-result boundary`,
        );
      }
    }

    // Step 3: Load config + tools (first tick only, cached on run state)
    if (!run.config) {
      run.config = await this.kernelRpc("ai.config", {
        profile: this.profile,
      });

      const toolsResult = await this.kernelRpc("ai.tools");
      run.tools = toolsResult.tools;

      this.currentRun = run;
    }

    // Step 4: Assemble prompt (first tick only)
    if (!run.systemPrompt) {
      run.systemPrompt = await assembleSystemPrompt({
        config: run.config!,
        profile: this.profile,
        purpose: "chat.reply",
        identity: this.identity,
        storage: this.env.STORAGE,
        ripgit: this.ripgit,
      });
      this.currentRun = run;
    }

    // Step 5: Build pi-ai Context
    const piMessages = this.store.toMessages();
    const tools: Tool[] = (run.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Tool["parameters"],
    }));

    const context: Context = {
      systemPrompt: run.systemPrompt,
      messages: piMessages,
      tools: tools.length > 0 ? tools : undefined,
    };

    // Step 6: Call LLM
    let response: AssistantMessage;
    try {
      console.log(
        `[Process] Calling generation service for chat.reply: ${run.config!.provider}/${run.config!.model}`,
      );
      response = await this.generation.generate({
        purpose: "chat.reply",
        config: run.config!,
        context,
      });
      console.log(
        `[Process] LLM response: ${response.content?.length ?? 0} blocks, stop=${response.stopReason}`,
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`[Process] LLM call failed:`, e);
      await this.sendSignal("chat.complete", {
        text: null,
        error: errorMsg,
        pid: this.pid,
        runId,
      });
      await this.finishRun("chat.error");
      return;
    }

    if (!response.content || response.content.length === 0) {
      const errorMsg = response.errorMessage ?? "LLM returned empty response";
      console.error(`[Process] ${errorMsg}`);
      await this.sendSignal("chat.complete", {
        text: null,
        error: errorMsg,
        pid: this.pid,
        runId,
      });
      await this.finishRun("chat.empty");
      return;
    }

    // Step 7: Process response
    const textBlocks = response.content.filter(
      (b): b is TextContent => b.type === "text",
    );
    const text = textBlocks.map((b) => b.text).join("");
    const toolCalls = response.content.filter(
      (b): b is ToolCall => b.type === "toolCall",
    );

    if (text.trim()) {
      await this.sendSignal("chat.text", { text, pid: this.pid, runId });
    }

    this.store.appendMessage("assistant", text, {
      toolCalls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined,
    });

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const syscall = TOOL_TO_SYSCALL[tc.name];

        await this.sendSignal("chat.tool_call", {
          name: tc.name,
          syscall,
          args: tc.arguments,
          callId: tc.id,
          pid: this.pid,
          runId,
        });

        if (!syscall) {
          this.store.appendToolResult(
            tc.id,
            tc.name,
            `Error: Unknown tool "${tc.name}"`,
            true,
          );
          await this.sendSignal("chat.tool_result", {
            name: tc.name,
            syscall: tc.name,
            callId: tc.id,
            ok: false,
            error: `Unknown tool "${tc.name}"`,
            pid: this.pid,
            runId,
          });
          continue;
        }

        await this.dispatchSyscall(
          runId,
          tc.id,
          syscall as SyscallName,
          tc.arguments,
        );
      }

      if (this.store.isRunResolved(runId)) {
        this.scheduleTick(runId);
      }
    } else {
      await this.sendSignal("chat.complete", {
        text,
        pid: this.pid,
        runId,
        usage: response.usage,
      });
      await this.finishRun("turn.complete");
    }
  }

  private async finishRun(reason: string): Promise<void> {
    try {
      await this.checkpointWorkspace(reason);
    } catch (error) {
      console.error(`[Process] Workspace checkpoint failed (${reason}):`, error);
    }

    const runId = this.currentRun?.runId;
    this.currentRun = null;
    console.log(`[Process] Finished run ${runId}`);

    const next = this.store.dequeue();
    if (next) {
      this.store.appendMessage("user", next.message);
      this.currentRun = { runId: next.runId, queued: false };
      this.scheduleTick(next.runId);
    }
  }

  /**
   * Synchronous kernel RPC — for syscalls the kernel handles natively
   * (ai.config, ai.tools, sys.config.get, etc.). Throws on error.
   */
  private async kernelRpc<T extends SyscallName>(
    call: T,
    args: unknown = {},
  ): Promise<ResultOf<T>> {
    const id = crypto.randomUUID();
    const frame = { type: "req", id, call, args } as RequestFrame;
    const response = await sendFrameToKernel(this.pid, frame);

    if (!response || response.type !== "res") {
      throw new Error(`No synchronous response for ${call}`);
    }
    if (!response.ok) {
      throw new Error((response as ResponseErrFrame).error.message);
    }
    return response.data as ResultOf<T>;
  }

  /**
   * Send a signal frame to the kernel for relay to client connections.
   */
  private async sendSignal(signal: string, payload?: unknown): Promise<void> {
    await sendFrameToKernel(this.pid, {
      type: "sig",
      signal,
      payload,
    } as SignalFrame);
  }

  private async checkpointWorkspace(reason: string): Promise<void> {
    const workspaceId = this.identity.workspaceId;
    if (!workspaceId || !this.ripgit) {
      return;
    }

    const messages = this.store.allMessagesForArchive();
    if (messages.length === 0) {
      return;
    }

    const checkpointedCount = Number.parseInt(
      this.store.getValue(CHECKPOINTED_MESSAGE_COUNT_KEY) ?? "0",
      10,
    );
    if (checkpointedCount === messages.length) {
      return;
    }

    const repo = workspaceRepoRef(workspaceId, this.identity.uid);
    const existingSummary = await this.readWorkspaceSummary(repo);
    const config = await this.resolveCheckpointConfig();
    const transcript = buildCheckpointTranscript(messages);

    const summary = await this.generateCheckpointSummary(
      config,
      existingSummary,
      messages,
    );
    const commitMessage = await this.generateCheckpointCommitMessage(
      config,
      summary,
      messages,
      reason,
    );

    await this.ripgit.apply(
      repo,
      this.identity.username,
      `${this.identity.username}@gsv.internal`,
      commitMessage,
      [
        {
          type: "put",
          path: ".gsv/summary.md",
          contentBytes: Array.from(TEXT_ENCODER.encode(summary)),
        },
        {
          type: "put",
          path: `.gsv/processes/${this.pid}/chat.jsonl`,
          contentBytes: Array.from(TEXT_ENCODER.encode(transcript)),
        },
      ],
    );

    this.store.setValue(CHECKPOINTED_MESSAGE_COUNT_KEY, String(messages.length));
  }

  private async readWorkspaceSummary(
    repo: ReturnType<typeof workspaceRepoRef>,
  ): Promise<string> {
    if (!this.ripgit) {
      return "";
    }
    const result = await this.ripgit.readPath(repo, ".gsv/summary.md");
    if (result.kind !== "file") {
      return "";
    }
    return new TextDecoder().decode(result.bytes);
  }

  private async resolveCheckpointConfig(): Promise<AiConfigResult | null> {
    if (this.currentRun?.config) {
      return this.currentRun.config;
    }
    try {
      return await this.kernelRpc("ai.config", {
        profile: this.profile,
      });
    } catch (error) {
      console.warn("[Process] Failed to resolve AI config for checkpointing:", error);
      return null;
    }
  }

  private async generateCheckpointSummary(
    config: AiConfigResult | null,
    existingSummary: string,
    messages: MessageRecord[],
  ): Promise<string> {
    if (!config) {
      return normalizeCheckpointSummary(existingSummary);
    }
    try {
      const generated = await this.generation.generateText({
        purpose: "checkpoint.summary",
        config,
        context: buildCheckpointSummaryContext(existingSummary, messages),
      });
      return normalizeCheckpointSummary(generated);
    } catch (error) {
      console.warn("[Process] Failed to generate checkpoint summary:", error);
      return normalizeCheckpointSummary(existingSummary);
    }
  }

  private async generateCheckpointCommitMessage(
    config: AiConfigResult | null,
    summary: string,
    messages: MessageRecord[],
    reason: string,
  ): Promise<string> {
    if (!config) {
      return this.defaultCheckpointCommitMessage(reason);
    }
    try {
      const generated = await this.generation.generateText({
        purpose: "checkpoint.commit_message",
        config,
        context: buildCheckpointCommitMessageContext(summary, messages, reason),
      });
      return normalizeCheckpointCommitMessage(generated);
    } catch (error) {
      console.warn("[Process] Failed to generate checkpoint commit message:", error);
      return this.defaultCheckpointCommitMessage(reason);
    }
  }

  private defaultCheckpointCommitMessage(reason: string): string {
    const normalizedReason = reason.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
    return normalizedReason ? `checkpoint ${normalizedReason}` : "checkpoint thread state";
  }

  private async archiveMessages(
    pid: string,
    archiveId: string,
  ): Promise<string | null> {
    const messages = this.store.allMessagesForArchive();
    if (messages.length === 0) return null;

    const jsonl = messages
      .map((m) =>
        JSON.stringify({
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
          tool_call_id: m.toolCallId ?? undefined,
          ts: m.createdAt,
        }),
      )
      .join("\n");

    const key = `var/sessions/${this.identity.username}/${pid}/${archiveId}.jsonl.gz`;

    const compressed = await gzip(jsonl);
    const bucket = this.env.STORAGE;
    await bucket.put(key, compressed, {
      httpMetadata: { contentType: "application/gzip" },
    });
    return key;
  }

  async dispatchSyscall(
    runId: string,
    id: string,
    call: SyscallName,
    args: unknown,
  ): Promise<void> {
    this.store.register(id, runId, call, args);

    const reqFrame: RequestFrame = {
      type: "req",
      id,
      call,
      args,
    } as RequestFrame;

    const response = await sendFrameToKernel(this.pid, reqFrame);

    if (response && response.type === "res") {
      const res = response;
      if (res.ok) {
        this.store.resolve(id, (res as { data?: unknown }).data);
      } else {
        this.store.fail(
          id,
          (res as { error: { message: string } }).error.message,
        );
      }
    }
  }
}

async function gzip(input: string): Promise<ArrayBuffer> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
