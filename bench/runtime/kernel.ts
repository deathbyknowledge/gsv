import {
  jsonObjectSchema,
  type AiToolsDevice,
  type JsonObject,
  type JsonValue,
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
import {
  environmentFromSpec,
  type SyntheticCapabilityEnvironment,
  type SyntheticInvocationResult,
} from "./environment";
import type {
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
  private readonly environments = new Map<string, SyntheticCapabilityEnvironment>();
  private readonly processes = new Map<string, SyntheticProcessSpec>();
  private readonly transitions = new Map<string, SyntheticTransitionSpec>();
  private readonly appliedTransitions = new Set<string>();
  private readonly now: Date;
  private readonly timezone: string;

  constructor(runtime: SyntheticWorldSpec["runtime"]) {
    this.now = new Date(runtime.now);
    if (Number.isNaN(this.now.valueOf())) {
      throw new Error("Synthetic runtime now must be an ISO timestamp");
    }
    this.timezone = runtime.timezone;
  }

  static fromSpec(
    world: SyntheticWorldSpec,
    transitions: readonly SyntheticTransitionSpec[] = [],
  ): SyntheticKernel {
    const kernel = new SyntheticKernel(world.runtime);
    for (const process of world.processes) kernel.addProcess(process);
    for (const target of world.targets) {
      kernel.addTarget(environmentFromSpec(target));
    }
    for (const transition of transitions) kernel.afterCall(transition);
    return kernel;
  }

  addProcess(process: SyntheticProcessSpec): void {
    if (this.processes.has(process.id)) {
      throw new Error("Duplicate synthetic process id: " + process.id);
    }
    this.processes.set(process.id, structuredClone(process));
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

  process(processId: string): SyntheticProcessSpec {
    return structuredClone(this.requireProcess(processId));
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
        ? this.dispatchNativeShell(processId, args)
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
      processes[process.id] = {
        ...structuredClone(process),
        visibleTargets: this.visibleEnvironments(process.id)
          .filter((target) => target.isOnline())
          .map((target) => target.id),
      };
    }
    return {
      targets,
      processes,
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

  private dispatchNativeShell(
    processId: string,
    args: JsonObject,
  ): SyntheticInvocationResult {
    const process = this.requireProcess(processId);
    if (!hasCapability(process.capabilities, "sys.device.list")) {
      return {
        value: {
          status: "failed",
          output: "",
          error: "Permission denied: sys.device.list",
        },
        isError: true,
      };
    }
    const parsedArgs = nativeShellArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      return {
        value: {
          status: "failed",
          output: "",
          error: "input must be a string",
        },
        isError: true,
      };
    }
    const parsed = parseTargetsListCommand(parsedArgs.data.input);
    if (!parsed) {
      return {
        value: {
          status: "failed",
          output: "",
          error: "Synthetic native shell supports targets list only",
        },
        isError: true,
      };
    }
    const entries = this.targetListEntries(processId, parsed.includeOffline);
    const output = parsed.json
      ? JSON.stringify({
        targets: entries,
        total: entries.length,
        limit: 100,
        offset: 0,
      }, null, 2) + "\n"
      : formatTargetTable(entries);
    return {
      value: {
        status: "completed",
        output,
        exitCode: 0,
        ok: true,
      },
      isError: false,
    };
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

  private requireEnvironment(targetId: string): SyntheticCapabilityEnvironment {
    const environment = this.environments.get(targetId);
    if (!environment) throw new Error("Unknown synthetic target: " + targetId);
    return environment;
  }
}

function parseTargetsListCommand(
  input: string,
): { includeOffline: boolean; json: boolean } | null {
  const words = input.trim().split(/\s+/u);
  if (words[0] !== "targets") return null;
  let index = 1;
  if (words[index] === "list") index += 1;
  let includeOffline = false;
  let json = false;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--all" || word === "--offline") includeOffline = true;
    else if (word === "--json") json = true;
    else return null;
  }
  return { includeOffline, json };
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
