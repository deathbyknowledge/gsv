import {
  Bash,
  InMemoryFs,
  defineCommand,
  type ExecResult,
} from "just-bash";
import {
  jsonObjectSchema,
  type AiToolsDevice,
  type JsonObject,
  type JsonValue,
  type ResponsibilityPatch,
  type ResponsibilityPriority,
  type ResponsibilityRecord,
  type ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { hasCapability } from "../../workers/gateway/src/kernel/capabilities";
import {
  GSV_TARGET_IMPLEMENTATIONS,
} from "../../workers/gateway/src/kernel/target-constants";
import {
  createContextProjection,
  type ContextProjection,
} from "../../workers/gateway/src/process/context/projection";
import { TOOL_TO_SYSCALL } from "../../workers/gateway/src/syscalls/constants";
import { SyntheticMessagingAdapter } from "./adapter";
import {
  environmentFromSpec,
  type SyntheticCapabilityEnvironment,
  type SyntheticInvocationResult,
} from "./environment";
import {
  processOwnerUid,
  SyntheticResponsibilityLedger,
} from "./responsibilities";
import type {
  GsvSemanticLogEntry,
  SyntheticAdapterDeliverySnapshot,
  SyntheticAdapterRouteSpec,
  SyntheticAdapterSnapshot,
  SyntheticAdapterSpec,
  SyntheticDelegateSpec,
  SyntheticDelegationSnapshot,
  SyntheticProcessSnapshot,
  SyntheticProcessSpec,
  SyntheticTargetSnapshot,
  SyntheticTransitionEffect,
  SyntheticTransitionSpec,
  SyntheticWorldSnapshot,
  SyntheticWorldSpec,
} from "./schema";

type TargetListEntry = {
  id: string;
  provider: "native" | "device" | "adapter";
  owner: string;
  label: string;
  description: string;
  platform: string;
  version: string;
  online: boolean;
  implements: string[];
};

type SyntheticProcessEvent = {
  sequence: number;
  content: string;
};

export type SyntheticProcessRunOutcome = {
  status: "yielded" | "returned" | "max_turns" | "invalid_action";
  resultText?: string;
  error?: string;
};

export type SyntheticDelegateRunRequest = {
  processId: string;
  systemPrompt: string;
  prompt: string;
  maxTurns: number;
};

type SyntheticDelegateRunner = (
  request: SyntheticDelegateRunRequest,
) => Promise<SyntheticProcessRunOutcome>;

type EntryRoute = {
  route: SyntheticAdapterRouteSpec;
  sentCount: number;
};

const routingArgsSchema = z.object({
  target: z.string().optional(),
}).passthrough();
const nativeShellArgsSchema = z.object({
  input: z.string(),
}).passthrough();

export type SyntheticDispatchResult = SyntheticInvocationResult & {
  transitionsApplied: string[];
};

export class SyntheticKernel {
  private readonly adapters = new Map<string, SyntheticMessagingAdapter>();
  private readonly adapterRoutes = new Map<string, EntryRoute>();
  private readonly delegateSpecs = new Map<string, SyntheticDelegateSpec>();
  private readonly delegations: SyntheticDelegationSnapshot[] = [];
  private readonly environments = new Map<string, SyntheticCapabilityEnvironment>();
  private readonly processes = new Map<string, SyntheticProcessSpec>();
  private readonly processEvents = new Map<string, SyntheticProcessEvent[]>();
  private readonly processParents = new Map<string, string>();
  private readonly processStates = new Map<
    string,
    SyntheticProcessSnapshot["state"]
  >();
  private readonly transitions = new Map<string, SyntheticTransitionSpec>();
  private readonly appliedTransitions = new Set<string>();
  private readonly now: Date;
  private readonly timezone: string;
  private readonly responsibilities: SyntheticResponsibilityLedger;
  private delegateRunner: SyntheticDelegateRunner | null = null;
  private recordSemanticEvent: ((entry: GsvSemanticLogEntry) => void) | null = null;
  private nextEventSequence = 1;

  constructor(runtime: SyntheticWorldSpec["runtime"]) {
    this.now = new Date(runtime.now);
    if (Number.isNaN(this.now.valueOf())) {
      throw new Error("Synthetic runtime now must be an ISO timestamp");
    }
    this.timezone = runtime.timezone;
    this.responsibilities = new SyntheticResponsibilityLedger((transition) => {
      this.recordSemanticEvent?.({
        type: "responsibility.transition",
        transition,
      });
    });
  }

  static fromSpec(
    world: SyntheticWorldSpec,
    transitions: readonly SyntheticTransitionSpec[] = [],
  ): SyntheticKernel {
    const kernel = new SyntheticKernel(world.runtime);
    for (const process of world.processes) kernel.addProcess(process);
    for (const delegate of world.delegates ?? []) kernel.addDelegate(delegate);
    for (const target of world.targets) {
      kernel.addTarget(environmentFromSpec(target));
    }
    for (const adapter of world.adapters ?? []) kernel.addAdapter(adapter);
    for (const transition of transitions) kernel.afterCall(transition);
    return kernel;
  }

  setRecorder(record: (entry: GsvSemanticLogEntry) => void): void {
    this.recordSemanticEvent = record;
  }

  setDelegateRunner(run: SyntheticDelegateRunner): void {
    this.delegateRunner = run;
  }

  addProcess(process: SyntheticProcessSpec): void {
    if (this.processes.has(process.id) || this.hasDelegateProcess(process.id)) {
      throw new Error("Duplicate synthetic process id: " + process.id);
    }
    const normalized: SyntheticProcessSpec = {
      ...structuredClone(process),
      ownerUid: processOwnerUid(process),
      username: process.username ?? process.id.replace(/^proc:/u, ""),
    };
    this.processes.set(process.id, normalized);
    this.processStates.set(process.id, "idle");
  }

  addDelegate(delegate: SyntheticDelegateSpec): void {
    if (this.delegateSpecs.has(delegate.account)) {
      throw new Error("Duplicate synthetic delegate account: " + delegate.account);
    }
    if (
      this.processes.has(delegate.process.id)
      || this.hasDelegateProcess(delegate.process.id)
    ) {
      throw new Error("Duplicate synthetic process id: " + delegate.process.id);
    }
    this.delegateSpecs.set(delegate.account, structuredClone(delegate));
  }

  addAdapter(spec: SyntheticAdapterSpec): void {
    if (this.adapters.has(spec.id)) {
      throw new Error("Duplicate synthetic adapter id: " + spec.id);
    }
    this.adapters.set(spec.id, new SyntheticMessagingAdapter(spec));
  }

  addTarget(environment: SyntheticCapabilityEnvironment): void {
    if (environment.id === "gsv") {
      throw new Error("The native gsv target is implicit and cannot be registered");
    }
    if (this.environments.has(environment.id)) {
      throw new Error("Duplicate synthetic target id: " + environment.id);
    }
    this.environments.set(environment.id, environment);
  }

  afterCall(transition: SyntheticTransitionSpec): void {
    if (this.transitions.has(transition.id)) {
      throw new Error("Duplicate synthetic transition id: " + transition.id);
    }
    this.requireProcess(transition.after.processId);
    for (const effect of transition.effects) this.requireEnvironment(effect.targetId);
    this.transitions.set(transition.id, structuredClone(transition));
  }

  bindAdapterIngress(
    processId: string,
    route: SyntheticAdapterRouteSpec,
  ): void {
    const process = this.requireProcess(processId);
    const adapter = this.requireAdapter(route.adapterId);
    if (adapter.ownerUid !== processOwnerUid(process)) {
      throw new Error("Adapter route owner does not own process " + processId);
    }
    adapter.admitInbound(processId, route);
    this.adapterRoutes.set(processId, {
      route: structuredClone(route),
      sentCount: 0,
    });
  }

  commitMessage(
    processId: string,
    text: string,
  ): SyntheticAdapterDeliverySnapshot | null {
    const routeState = this.adapterRoutes.get(processId);
    if (!routeState) return null;
    routeState.sentCount += 1;
    const deliveryId = routeState.route.inboundDeliveryId
      + ":reply:"
      + routeState.sentCount;
    const delivery = this.requireAdapter(routeState.route.adapterId).send(
      processId,
      routeState.route,
      deliveryId,
      text,
    );
    this.recordSemanticEvent?.({
      type: "adapter.sent",
      adapterId: routeState.route.adapterId,
      deliveryId,
      processId,
      text,
    });
    return delivery;
  }

  process(processId: string): SyntheticProcessSpec {
    return structuredClone(this.requireProcess(processId));
  }

  setProcessState(
    processId: string,
    state: SyntheticProcessSnapshot["state"],
  ): void {
    this.requireProcess(processId);
    this.processStates.set(processId, state);
  }

  projection(processId: string): ContextProjection {
    const devices: AiToolsDevice[] = this.visibleEnvironments(processId)
      .filter((target) => target.isOnline())
      .map((target) => ({
        id: target.id,
        label: target.label,
        description: target.description,
        platform: target.platform,
        implements: [...target.implements],
      }));
    return createContextProjection({
      devices,
      mcpServers: [],
      system: { timezone: this.timezone },
      skillIndex: [],
      skillIndexMode: "summary",
    }, this.now);
  }

  responsibilityBaseline(processId: string) {
    return this.responsibilities.list(this.requireProcess(processId));
  }

  responsibilityChanges(
    processId: string,
    afterRevision: number,
  ): ResponsibilityTransition[] {
    return this.responsibilities.changes(
      this.requireProcess(processId),
      afterRevision,
    );
  }

  drainProcessEvents(processId: string): SyntheticProcessEvent[] {
    this.requireProcess(processId);
    const events = this.processEvents.get(processId) ?? [];
    this.processEvents.delete(processId);
    return events.map((event) => structuredClone(event));
  }

  async dispatch(
    processId: string,
    toolName: string,
    args: JsonObject,
  ): Promise<SyntheticDispatchResult> {
    const process = this.requireProcess(processId);
    const syscall = TOOL_TO_SYSCALL[toolName];
    if (!syscall) {
      return this.finishDispatch(processId, toolName, args, {
        value: 'Tool "' + toolName + '" is not part of the GSV syscall surface',
        isError: true,
      });
    }
    if (!hasCapability(process.capabilities, syscall)) {
      return this.finishDispatch(processId, toolName, args, {
        value: "Permission denied: process cannot call " + syscall,
        isError: true,
      });
    }

    const routing = routingArgsSchema.safeParse(args);
    if (!routing.success) {
      return this.finishDispatch(processId, toolName, args, {
        value: "target must be a string",
        isError: true,
      });
    }
    const targetId = routing.data.target
      ? routing.data.target
      : syscall === "shell.exec"
        ? "gsv"
        : null;
    if (!targetId) {
      return this.finishDispatch(processId, toolName, args, {
        value: "A target is required for " + syscall,
        isError: true,
      });
    }

    if (targetId === "gsv" || targetId === "gateway") {
      const result = syscall === "shell.exec"
        ? await this.dispatchNativeShell(processId, args)
        : {
          value: "Synthetic native gsv does not implement " + syscall,
          isError: true,
        };
      return this.finishDispatch(processId, toolName, args, result);
    }

    const environment = this.environments.get(targetId);
    if (!environment || !environment.canAccess(process.uid, process.gids)) {
      return this.finishDispatch(processId, toolName, args, {
        value: "Target not found or inaccessible: " + targetId,
        isError: true,
      });
    }
    if (!environment.isOnline()) {
      return this.finishDispatch(processId, toolName, args, {
        value: "Target offline: " + targetId,
        isError: true,
      });
    }
    if (!environment.canHandle(syscall)) {
      return this.finishDispatch(processId, toolName, args, {
        value: "Target " + targetId + " does not implement " + syscall,
        isError: true,
      });
    }
    return this.finishDispatch(
      processId,
      toolName,
      args,
      await environment.invoke(syscall, args),
    );
  }

  snapshot(): SyntheticWorldSnapshot {
    const targets: Record<string, SyntheticTargetSnapshot> = {};
    for (const environment of [...this.environments.values()]
      .sort((left, right) => left.id.localeCompare(right.id))) {
      targets[environment.id] = environment.snapshot();
    }

    const processes: Record<string, SyntheticProcessSnapshot> = {};
    for (const process of [...this.processes.values()]
      .sort((left, right) => left.id.localeCompare(right.id))) {
      const snapshot: SyntheticProcessSnapshot = {
        id: process.id,
        role: process.role,
        uid: process.uid,
        ownerUid: processOwnerUid(process),
        username: process.username ?? process.id,
        gids: [...process.gids],
        capabilities: [...process.capabilities],
        visibleTargets: this.visibleEnvironments(process.id)
          .filter((target) => target.isOnline())
          .map((target) => target.id),
        state: this.processStates.get(process.id) ?? "idle",
      };
      const parentProcessId = this.processParents.get(process.id);
      if (parentProcessId) snapshot.parentProcessId = parentProcessId;
      processes[process.id] = snapshot;
    }

    const adapters: Record<string, SyntheticAdapterSnapshot> = {};
    for (const adapter of [...this.adapters.values()]
      .sort((left, right) => left.id.localeCompare(right.id))) {
      adapters[adapter.id] = adapter.snapshot();
    }

    return {
      targets,
      processes,
      adapters,
      responsibilities: this.responsibilities.snapshot(),
      delegations: this.delegations.map((delegation) => structuredClone(delegation)),
      transitionsApplied: [...this.appliedTransitions],
    };
  }

  private async finishDispatch(
    processId: string,
    toolName: string,
    args: JsonObject,
    result: SyntheticInvocationResult,
  ): Promise<SyntheticDispatchResult> {
    const transitionsApplied = this.applyMatchingTransitions(
      processId,
      toolName,
      args,
      result.isError,
    );
    return { ...result, transitionsApplied };
  }

  private async dispatchNativeShell(
    processId: string,
    args: JsonObject,
  ): Promise<SyntheticInvocationResult> {
    const parsedArgs = nativeShellArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      return shellFailure("input must be a string");
    }
    const bash = new Bash({
      fs: new InMemoryFs(),
      cwd: "/",
      env: {
        HOME: "/home/synthetic",
        USER: this.requireProcess(processId).username ?? processId,
        GSV_PID: processId,
      },
      customCommands: [
        defineCommand("man", async (commandArgs) => (
          this.runManCommand(commandArgs)
        )),
        defineCommand("targets", async (commandArgs) => (
          this.runTargetsCommand(processId, commandArgs)
        )),
        defineCommand("r12y", async (commandArgs) => (
          this.runR12yCommand(processId, commandArgs)
        )),
        defineCommand("proc", async (commandArgs) => (
          this.runProcCommand(processId, commandArgs)
        )),
      ],
    });
    try {
      const result = await bash.exec(parsedArgs.data.input, { cwd: "/" });
      const output = result.stdout + result.stderr;
      return result.exitCode === 0
        ? {
          value: {
            status: "completed",
            output,
            exitCode: result.exitCode,
            ok: true,
          },
          isError: false,
        }
        : {
          value: {
            status: "failed",
            output,
            error: result.stderr.trim() || "Command exited with code " + result.exitCode,
            exitCode: result.exitCode,
            ok: true,
          },
          isError: true,
        };
    } catch (error) {
      return shellFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private runManCommand(args: string[]): ExecResult {
    const [topic, ...rest] = args;
    if (topic === "--search" || topic === "-k") {
      const query = rest.filter((argument) => argument !== "--").join(" ");
      return commandResult(renderManualSearch(query));
    }
    if (!topic || topic === "--help" || topic === "-h") {
      return commandResult([
        "Usage: man TOPIC",
        "       man --search -- QUERY",
        "",
        "Synthetic GSV topics: targets, r12y, proc",
        "",
      ].join("\n"));
    }
    if (topic === "r12y") return commandResult(r12yUsage());
    const manual = renderSyntheticManualPage(topic);
    return manual
      ? commandResult(manual)
      : commandError("man", new Error("no manual entry for " + topic));
  }

  private runTargetsCommand(processId: string, args: string[]): ExecResult {
    try {
      this.requireCapability(processId, "sys.device.list");
      const parsed = parseTargetsListArgs(args);
      const entries = this.targetListEntries(processId, parsed.includeOffline);
      const output = parsed.json
        ? JSON.stringify({
          targets: entries,
          total: entries.length,
          limit: 100,
          offset: 0,
        }, null, 2) + "\n"
        : formatTargetTable(entries);
      return { stdout: output, stderr: "", exitCode: 0 };
    } catch (error) {
      return commandError(
        "targets",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private runR12yCommand(processId: string, args: string[]): ExecResult {
    try {
      const process = this.requireProcess(processId);
      const [subcommand = "help", ...rest] = args;
      if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        return commandResult(r12yUsage());
      }
      if (subcommand === "list") {
        this.requireCapability(processId, "r12y.list");
        const unexpected = rest.find((argument) => (
          argument !== "--all" && argument !== "--json"
        ));
        if (unexpected) throw new Error("unexpected list option: " + unexpected);
        const listed = this.responsibilities.list(process, rest.includes("--all"));
        return commandResult(rest.includes("--json")
          ? JSON.stringify(listed) + "\n"
          : renderResponsibilityList(listed.responsibilities, listed.revision));
      }
      if (subcommand === "show") {
        this.requireCapability(processId, "r12y.get");
        requireArgumentCount(rest, 1, "show requires: r12y show ID");
        const responsibility = this.responsibilities.get(process, requireValue(rest[0], "id"));
        return commandResult(JSON.stringify({
          responsibility,
          revision: this.responsibilities.revision(processOwnerUid(process)),
        }) + "\n");
      }
      if (subcommand === "create") {
        this.requireCapability(processId, "r12y.create");
        const input = parseResponsibilityCreate(rest);
        const created = this.responsibilities.create({ process, ...input }, this.now.valueOf());
        return commandResult(JSON.stringify(created) + "\n");
      }
      if (subcommand === "start") {
        this.requireCapability(processId, "r12y.update");
        requireArgumentCount(rest, 1, "start requires: r12y start ID");
        const responsibility = this.responsibilities.update({
          process,
          id: requireValue(rest[0], "id"),
          patch: { state: "active" },
        }, this.now.valueOf());
        return this.responsibilityUpdateResult(process, responsibility);
      }
      if (subcommand === "resolve" || subcommand === "cancel") {
        this.requireCapability(processId, "r12y.update");
        const id = requireValue(rest[0], "id");
        const patch: ResponsibilityPatch = {
          state: subcommand === "resolve" ? "resolved" : "cancelled",
        };
        if (rest.length > 1) {
          if (rest.length !== 3 || rest[1] !== "--json") {
            throw new Error(subcommand + " accepts only: --json RESOLUTION");
          }
          patch.resolution = jsonObjectSchema.parse(JSON.parse(rest[2] ?? ""));
        }
        const responsibility = this.responsibilities.update({ process, id, patch }, this.now.valueOf());
        return this.responsibilityUpdateResult(process, responsibility);
      }
      throw new Error("unknown command: " + subcommand + "\n" + r12yUsage());
    } catch (error) {
      return commandError(
        "r12y",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async runProcCommand(
    processId: string,
    args: string[],
  ): Promise<ExecResult> {
    try {
      const [subcommand = "help", ...rest] = args;
      if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        return commandResult(procUsage());
      }
      if (subcommand === "self") return commandResult(processId + "\n");
      if (subcommand !== "delegate") {
        throw new Error("unknown command: " + subcommand + "\n" + procUsage());
      }
      this.requireCapability(processId, "proc.spawn");
      this.requireCapability(processId, "proc.ipc.call");
      const input = parseProcDelegate(rest);
      if (input.responsibilityId) {
        this.requireCapability(processId, "r12y.get");
        this.requireCapability(processId, "r12y.update");
      }
      return await this.delegate(processId, input);
    } catch (error) {
      return commandError(
        "proc",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async delegate(
    sourceProcessId: string,
    input: ParsedProcDelegate,
  ): Promise<ExecResult> {
    if (!this.delegateRunner) {
      throw new Error("synthetic Process runner is not attached");
    }
    const source = this.requireProcess(sourceProcessId);
    const template = this.selectDelegate(input.runAs, processOwnerUid(source));
    const target = template.process;
    this.delegateSpecs.delete(template.account);
    this.addProcess(target);
    this.processParents.set(target.id, sourceProcessId);
    this.recordSemanticEvent?.({
      type: "process.spawned",
      processId: target.id,
      parentProcessId: sourceProcessId,
      account: template.account,
    });

    const ordinal = this.delegations.length + 1;
    const callId = "ipc:00000000-0000-4000-8000-"
      + ordinal.toString(16).padStart(12, "0");
    const runId = "run:00000000-0000-4000-8000-"
      + ordinal.toString(16).padStart(12, "0");
    const checkInMs = input.checkInMs ?? 10 * 60_000;
    const deadlineAt = this.now.valueOf() + checkInMs;
    if (input.responsibilityId) {
      this.responsibilities.get(source, input.responsibilityId);
      this.responsibilities.update({
        process: source,
        id: input.responsibilityId,
        patch: {
          assignee: { kind: "process", processId: target.id },
          state: "active",
          blocker: null,
          nextCheckAtMs: null,
          leaseExpiresAtMs: deadlineAt,
        },
      }, this.now.valueOf());
    }
    const delegation: SyntheticDelegationSnapshot = {
      callId,
      runId,
      sourceProcessId,
      targetProcessId: target.id,
      state: "in_progress",
    };
    if (input.responsibilityId) delegation.responsibilityId = input.responsibilityId;
    this.delegations.push(delegation);

    const prompt = formatDelegatedTask(
      source,
      input.message,
      this.now,
      deadlineAt,
    );
    let outcome: SyntheticProcessRunOutcome;
    try {
      outcome = await this.delegateRunner({
        processId: target.id,
        systemPrompt: template.systemPrompt,
        prompt,
        maxTurns: template.maxTurns,
      });
    } catch (error) {
      outcome = {
        status: "invalid_action",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const resultText = outcome.resultText;
    const completed = outcome.status === "returned" && resultText !== undefined;
    delegation.state = completed ? "completed" : "failed";
    if (completed) {
      delegation.resultText = resultText;
      delegation.normalizedResultText = resultText.trim();
    }
    else delegation.error = outcome.error ?? "Delegated process did not return a result";
    if (input.responsibilityId) {
      const current = this.responsibilities.get(source, input.responsibilityId);
      if (
        current.assignee.kind === "process"
        && current.assignee.processId === target.id
        && current.state !== "resolved"
        && current.state !== "cancelled"
      ) {
        this.responsibilities.update({
          process: source,
          id: current.id,
          patch: {
            assignee: { kind: "ship" },
            leaseExpiresAtMs: null,
          },
        }, this.now.valueOf());
      }
    }
    const event = formatIpcReply(
      target.id,
      callId,
      delegation.resultText,
      delegation.error,
    );
    this.queueProcessEvent(sourceProcessId, event);
    const completedEvent: GsvSemanticLogEntry = {
      type: "ipc.completed",
      callId,
      sourceProcessId,
      targetProcessId: target.id,
    };
    if (delegation.resultText !== undefined) {
      completedEvent.resultText = delegation.resultText;
    }
    if (delegation.error !== undefined) completedEvent.error = delegation.error;
    this.recordSemanticEvent?.(completedEvent);

    const label = input.label ?? summarizeDelegateLabel(input.message);
    return commandResult([
      "status=in_progress",
      "task=" + callId,
      "pid=" + target.id,
      "run_id=" + runId,
      "queued=false",
      "check_in=" + new Date(deadlineAt).toISOString(),
      "label=" + JSON.stringify(label),
      input.responsibilityId
        ? "responsibility=" + input.responsibilityId
        : "",
    ].filter(Boolean).join(" ") + "\n");
  }

  private responsibilityUpdateResult(
    process: SyntheticProcessSpec,
    responsibility: ResponsibilityRecord,
  ): ExecResult {
    return commandResult(JSON.stringify({
      responsibility,
      revision: this.responsibilities.revision(processOwnerUid(process)),
    }) + "\n");
  }

  private targetListEntries(
    processId: string,
    includeOffline: boolean,
  ): TargetListEntry[] {
    const native: TargetListEntry = {
      id: "gsv",
      provider: "native",
      owner: "system",
      label: "GSV",
      description: "Native GSV capability environment.",
      platform: "cloudflare",
      version: "",
      online: true,
      implements: [...GSV_TARGET_IMPLEMENTATIONS],
    };
    const external = this.visibleEnvironments(processId)
      .filter((target) => includeOffline || target.isOnline())
      .map((target): TargetListEntry => ({
        id: target.id,
        provider: target.kind === "slack" ? "adapter" : "device",
        owner: String(target.ownerUid),
        label: target.label,
        description: target.description,
        platform: target.platform,
        version: target.version,
        online: target.isOnline(),
        implements: [...target.implements],
      }));
    return [native, ...external];
  }

  private applyMatchingTransitions(
    processId: string,
    toolName: string,
    args: JsonObject,
    isError: boolean,
  ): string[] {
    const applied: string[] = [];
    for (const transition of this.transitions.values()) {
      if (this.appliedTransitions.has(transition.id)) continue;
      const trigger = transition.after;
      const outcome = trigger.outcome ?? "success";
      if (
        trigger.processId !== processId
        || trigger.tool !== toolName
        || (outcome === "success" && isError)
        || (outcome === "error" && !isError)
        || !jsonSubset(args, trigger.arguments ?? {})
      ) {
        continue;
      }
      for (const effect of transition.effects) this.applyEffect(effect);
      this.appliedTransitions.add(transition.id);
      applied.push(transition.id);
    }
    return applied;
  }

  private applyEffect(effect: SyntheticTransitionEffect): void {
    const environment = this.requireEnvironment(effect.targetId);
    switch (effect.type) {
      case "target.online":
        environment.setOnline(effect.online);
        break;
      case "target.access.grant":
        environment.grantAccess(effect.gid);
        break;
      case "target.access.revoke":
        environment.revokeAccess(effect.gid);
        break;
      case "target.state.set":
        environment.setState(effect.key, effect.value);
        break;
      case "target.file.write":
        environment.writeFile(effect.path, effect.content);
        break;
    }
  }

  private queueProcessEvent(processId: string, content: string): void {
    const events = this.processEvents.get(processId) ?? [];
    events.push({ sequence: this.nextEventSequence, content });
    this.nextEventSequence += 1;
    this.processEvents.set(processId, events);
  }

  private selectDelegate(
    account: string | undefined,
    ownerUid: number,
  ): SyntheticDelegateSpec {
    const candidates = account
      ? [this.delegateSpecs.get(account)].filter(
        (value): value is SyntheticDelegateSpec => value !== undefined,
      )
      : [...this.delegateSpecs.values()];
    const delegate = candidates.find((candidate) => (
      processOwnerUid(candidate.process) === ownerUid
    ));
    if (!delegate) {
      throw new Error(account
        ? "unknown or unavailable agent account: " + account
        : "no synthetic delegate is available for this owner");
    }
    return structuredClone(delegate);
  }

  private requireCapability(processId: string, capability: string): void {
    if (!hasCapability(this.requireProcess(processId).capabilities, capability)) {
      throw new Error("Permission denied: " + capability);
    }
  }

  private visibleEnvironments(processId: string): SyntheticCapabilityEnvironment[] {
    const process = this.requireProcess(processId);
    return [...this.environments.values()]
      .filter((target) => target.canAccess(process.uid, process.gids))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private requireProcess(processId: string): SyntheticProcessSpec {
    const process = this.processes.get(processId);
    if (!process) throw new Error("Unknown synthetic process: " + processId);
    return process;
  }

  private hasDelegateProcess(processId: string): boolean {
    return [...this.delegateSpecs.values()].some(({ process }) => (
      process.id === processId
    ));
  }

  private requireEnvironment(targetId: string): SyntheticCapabilityEnvironment {
    const environment = this.environments.get(targetId);
    if (!environment) throw new Error("Unknown synthetic target: " + targetId);
    return environment;
  }

  private requireAdapter(adapterId: string): SyntheticMessagingAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error("Unknown synthetic adapter: " + adapterId);
    return adapter;
  }
}

type ParsedProcDelegate = {
  runAs?: string;
  label?: string;
  checkInMs?: number;
  responsibilityId?: string;
  message: string;
};

type ParsedTargetList = {
  includeOffline: boolean;
  json: boolean;
};

type ParsedResponsibilityCreate = {
  title: string;
  details?: JsonObject;
  priority?: ResponsibilityPriority;
  dedupeKey?: string;
};

function parseTargetsListArgs(
  args: string[],
): ParsedTargetList {
  let index = 0;
  if (args[index] === "list") index += 1;
  let includeOffline = false;
  let json = false;
  for (; index < args.length; index += 1) {
    const word = args[index];
    if (word === "--all" || word === "--offline") includeOffline = true;
    else if (word === "--json") json = true;
    else throw new Error("unexpected option: " + word);
  }
  return { includeOffline, json };
}

function parseResponsibilityCreate(args: string[]): ParsedResponsibilityCreate {
  let title: string | undefined;
  let details: JsonObject | undefined;
  let priority: ResponsibilityPriority | undefined;
  let dedupeKey: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    index += 1;
    const value = requireValue(args[index], option ?? "option");
    if (option === "--title") title = value;
    else if (option === "--details") {
      details = jsonObjectSchema.parse(JSON.parse(value));
    } else if (option === "--priority") {
      if (!isResponsibilityPriority(value)) {
        throw new Error("invalid priority: " + value);
      }
      priority = value;
    } else if (option === "--dedupe") dedupeKey = value;
    else throw new Error("unexpected create option: " + option);
  }
  if (!title) throw new Error("create requires --title TITLE");
  const result: ParsedResponsibilityCreate = { title };
  if (details !== undefined) result.details = details;
  if (priority !== undefined) result.priority = priority;
  if (dedupeKey !== undefined) result.dedupeKey = dedupeKey;
  return result;
}

function parseProcDelegate(args: string[]): ParsedProcDelegate {
  let runAs: string | undefined;
  let label: string | undefined;
  let checkInMs: number | undefined;
  let responsibilityId: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (current === "--as" || current === "--run-as") {
      index += 1;
      runAs = requireValue(args[index], current);
      continue;
    }
    if (current === "--label") {
      index += 1;
      label = requireValue(args[index], current);
      continue;
    }
    if (current === "--check-after" || current === "--timeout") {
      index += 1;
      if (checkInMs !== undefined) {
        throw new Error("delegation check-in may only be specified once");
      }
      checkInMs = parseDurationMs(requireValue(args[index], current));
      continue;
    }
    if (current === "--responsibility") {
      index += 1;
      responsibilityId = requireValue(args[index], current);
      continue;
    }
    if (current?.startsWith("--")) {
      throw new Error("unexpected option: " + current);
    }
    if (current !== undefined) positional.push(current);
  }
  const message = positional.join(" ").trim();
  if (!message) throw new Error("missing delegated task");
  const result: ParsedProcDelegate = { message };
  if (runAs) result.runAs = runAs;
  if (label) result.label = label;
  if (checkInMs !== undefined) result.checkInMs = checkInMs;
  if (responsibilityId) result.responsibilityId = responsibilityId;
  return result;
}

function renderResponsibilityList(
  records: ResponsibilityRecord[],
  revision: number,
): string {
  const lines = [`REVISION\t${revision}`, "ID\tSTATE\tPRIORITY\tASSIGNEE\tDUE\tTITLE"];
  for (const record of records) {
    lines.push([
      record.id,
      record.state,
      record.priority,
      record.assignee.kind === "ship" ? "ship" : record.assignee.processId,
      record.dueAtMs === undefined ? "-" : new Date(record.dueAtMs).toISOString(),
      record.title.replace(/[\t\r\n]+/gu, " "),
    ].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function formatDelegatedTask(
  source: SyntheticProcessSpec,
  message: string,
  now: Date,
  deadlineAt: number,
): string {
  return [
    `Delegated task from ${source.username ?? source.id} (${source.id}).`,
    `Received: ${now.toISOString()}.`,
    "",
    message,
    "",
    `GSV will check on this task after ${new Date(deadlineAt).toISOString()}.`,
    "This is not a termination deadline; continue until the task reaches a real terminal outcome.",
    "Your final answer will be returned to the caller automatically.",
  ].join("\n");
}

function formatIpcReply(
  targetProcessId: string,
  callId: string,
  resultText?: string,
  error?: string,
): string {
  const lines = [
    `Delegated task from process \`${targetProcessId}\` finished.`,
    `Task id: \`${callId}\`.`,
  ];
  if (error) lines.push("", "Error:", error);
  if (resultText !== undefined) lines.push("", "Result:", resultText);
  return lines.join("\n");
}

function formatTargetTable(entries: readonly TargetListEntry[]): string {
  const lines = ["TARGET\tPROVIDER\tSTATE\tPLATFORM\tCAPS\tLABEL"];
  for (const entry of entries) {
    lines.push([
      entry.id,
      entry.provider,
      entry.online ? "online" : "offline",
      entry.platform || "-",
      entry.implements.join(",") || "-",
      entry.label || "-",
    ].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function commandResult(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function commandError(command: string, error: Error): ExecResult {
  return {
    stdout: "",
    stderr: command + ": " + error.message + "\n",
    exitCode: 1,
  };
}

function shellFailure(error: string): SyntheticInvocationResult {
  return {
    value: { status: "failed", output: "", error },
    isError: true,
  };
}

function requireArgumentCount(
  args: string[],
  count: number,
  message: string,
): void {
  if (args.length !== count) throw new Error(message);
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error("missing value for " + name);
  return value;
}

function isResponsibilityPriority(value: string): value is ResponsibilityPriority {
  return value === "low"
    || value === "normal"
    || value === "high"
    || value === "critical";
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/u.exec(value);
  if (!match) throw new Error("invalid duration: " + value);
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms"
    ? 1
    : unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : 3_600_000;
  return amount * multiplier;
}

function summarizeDelegateLabel(message: string): string {
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return firstLine.length <= 48
    ? firstLine || "delegated task"
    : firstLine.slice(0, 45) + "...";
}

function procUsage(): string {
  return [
    "Usage:",
    "  proc self",
    "  proc delegate [--as ACCOUNT] [--label LABEL] [--check-after 10m] [--responsibility ID] <task>",
    "",
    "proc delegate creates a durable child process and returns a task handle immediately.",
    "The child result later arrives as a delegated task event.",
    "",
  ].join("\n");
}

function r12yUsage(): string {
  return [
    "Usage:",
    "  r12y list [--all] [--json]",
    "  r12y show ID",
    "  r12y create --title TITLE [--details JSON] [--priority PRIORITY] [--dedupe KEY]",
    "  r12y start ID",
    "  r12y resolve ID [--json RESOLUTION]",
    "  r12y cancel ID [--json RESOLUTION]",
    "",
    "Responsibilities are durable unresolved work owned by the Kernel.",
    "",
  ].join("\n");
}

function renderManualSearch(query: string): string {
  const normalized = query.trim().toLowerCase();
  if (/event|target|device|online|available/u.test(normalized)) {
    return [
      "process-events - ordered [GSV EVENT] entries are delivered directly in Process context",
      "targets - list the complete current target projection with `targets list --json`",
      "",
      "There is no separate event-log shell command. Act on the delivered event;",
      "use `targets list --json` only when you need to inspect current target state.",
      "",
    ].join("\n");
  }
  if (/responsib|promise|ledger|r12y/u.test(normalized)) {
    return "r12y - retain and supervise durable responsibilities (`man r12y`)\n";
  }
  if (/process|delegate|worker|ipc|proc/u.test(normalized)) {
    return "proc - inspect processes and delegate bounded work (`man proc`)\n";
  }
  return [
    "targets - discover Unix-shaped capability environments",
    "r12y - retain and supervise durable responsibilities",
    "proc - inspect processes and delegate bounded work",
    "",
  ].join("\n");
}

function renderSyntheticManualPage(topic: string): string | null {
  switch (topic.trim().toLowerCase()) {
    case "targets":
    case "devices":
      return [
        "TARGETS(1)",
        "",
        "NAME",
        "  targets - discover Unix-shaped capability environments",
        "",
        "SYNOPSIS",
        "  targets list [--all] [--json]",
        "",
      ].join("\n");
    case "proc":
      return procUsage();
    default:
      return null;
  }
}

function jsonSubset(value: JsonValue, expected: JsonValue): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(value)
      && value.length === expected.length
      && expected.every((item, index) => jsonSubset(value[index] ?? null, item));
  }
  const expectedObject = jsonObjectSchema.safeParse(expected);
  if (expectedObject.success) {
    const valueObject = jsonObjectSchema.safeParse(value);
    if (!valueObject.success) return false;
    return Object.entries(expectedObject.data).every(([key, item]) => (
      key in valueObject.data
      && jsonSubset(valueObject.data[key] ?? null, item)
    ));
  }
  return value === expected;
}
