import { defineCommand } from "just-bash";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { SysInstanceGetResult, SysInstanceStartResult } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import type { RequestFrame } from "../../../protocol/frames";
import type { NativeShellCommandOptions } from "./commands";
import { requireCommandCapability, requireShellOptionValue } from "./common";

const INSTANCE_HELP = `Usage:
  instance catalog
  instance start browser --request-id ID [--wait] [--timeout MS] [--new] [--profile ID] [--name NAME] [--seconds N]
  instance list [--all]
  instance get ID | instance get --request-id ID
  instance stop ID [--wait] [--timeout MS] [--force] | instance stop --request-id ID [--wait] [--force]

Keep the request ID before starting. If the response is lost, get by that ID; do not start again with a new ID.
Start reuses your current browser, including one still starting, without extending its lifetime. Use another tab for additional work.
--wait returns when ready (default timeout 60000 ms, maximum 120000). Cancelling or timing out only stops waiting; get by the saved request ID to recover.
The result says disposition: created or reused. IDs accept the displayed target ID or full instance ID.
--new explicitly starts a separate, temporary browser. Ordinary starts remember logins for your account automatically.
Stop saves before closing. If saving fails the browser stays running; retry or use --force to discard unsaved changes. Stop --wait waits for shutdown and releases the saved login state for the next browser.
Instances have a fixed lifetime. Close your task's tabs when finished; do not stop a shared browser just because your task ended. Stop an isolated browser you created when finished. A stopped instance never restarts.
`;
const BROWSER_HELP = `Usage:
  browser profile list
  browser profile create NAME --request-id ID
  browser profile get ID
  browser profile save INSTANCE
  browser profile delete ID
  browser handoff request INSTANCE TAB --request-id ID --purpose TEXT [--work RESPONSIBILITY_ID]
  browser handoff get INSTANCE REQUEST_ID
  browser handoff cancel INSTANCE REQUEST_ID

Run tabs/page commands on the browser target. Handoffs pause automation until the person finishes in GSV.
Agent handoffs must reference the responsibility for the waiting work. Send the action URL to the user, then yield.
`;

function parseOptions(args: string[], allowed: string[]) {
  const words: string[] = [], options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    if (!allowed.includes(arg) || options[arg] !== undefined) throw new Error(`Unexpected option: ${arg}`);
    options[arg] = arg === "--all" || arg === "--new" || arg === "--wait" || arg === "--force" ? "true" : requireShellOptionValue(args[++i], arg);
  }
  return { words, options };
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function buildInstanceCommands(ctx: KernelContext, request?: NativeShellCommandOptions["request"]) {
  return ["instance", "browser"].map(name => defineCommand(name, async (argv, shell) => {
    const help = name === "instance" ? INSTANCE_HELP : BROWSER_HELP;
    if (!argv.length || argv.includes("--help") || argv.includes("-h")) return { stdout: help, stderr: "", exitCode: 0 };
    try {
      let frame: RequestFrame;
      let waitMs: number | undefined;
      const id = crypto.randomUUID();
      if (name === "instance") {
        const { words, options } = parseOptions(argv, ["--request-id", "--profile", "--name", "--seconds", "--all", "--new", "--wait", "--timeout", "--force"]);
        const [verb, target] = words;
        const allowed = verb === "start" ? ["--request-id", "--profile", "--name", "--seconds", "--new", "--wait", "--timeout"]
          : verb === "list" ? ["--all"] : verb === "stop" ? ["--request-id", "--wait", "--timeout", "--force"] : verb === "get" ? ["--request-id"] : [];
        for (const option of Object.keys(options)) if (!allowed.includes(option)) throw new Error(`Unexpected option for ${verb}: ${option}`);
        if (options["--timeout"] && !options["--wait"]) throw new Error("--timeout requires --wait");
        if (options["--wait"]) {
          waitMs = Number(options["--timeout"] ?? 60000);
          if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 120000) throw new Error("--timeout must be between 1 and 120000 ms");
          requireCommandCapability(ctx, "sys.instance.get");
        }
        if (verb === "catalog" && words.length === 1) frame = { type: "req", id, call: "sys.instance.catalog", args: {} };
        else if (verb === "list" && words.length === 1) frame = { type: "req", id, call: "sys.instance.list", args: { includeTerminal: options["--all"] === "true" } };
        else if ((verb === "get" || verb === "stop") && words.length <= 2 && (target || options["--request-id"])) {
          if (target && options["--request-id"]) throw new Error("Choose either an instance ID or --request-id");
          const selector = target ? { instanceId: target } : { startRequestId: options["--request-id"] };
          frame = verb === "get" ? { type: "req", id, call: "sys.instance.get", args: selector } : { type: "req", id, call: "sys.instance.stop", args: { ...selector, force: options["--force"] === "true" || undefined } };
        } else if (verb === "start" && words.length === 2) {
          if (!options["--request-id"]) throw new Error("instance start requires --request-id");
          frame = { type: "req", id, call: "sys.instance.start", args: {
            requestId: options["--request-id"], templateId: target, profileId: options["--profile"], label: options["--name"],
            lifetimeSeconds: options["--seconds"] ? Number(options["--seconds"]) : undefined,
            fresh: options["--new"] === "true" || undefined,
          } };
        } else throw new Error(help);
      } else {
        const { words, options } = parseOptions(argv, ["--request-id", "--purpose", "--work"]);
        const [group, verb, value, tabOrRequest] = words;
        if (group === "profile") {
          if (verb === "list" && words.length === 2) frame = { type: "req", id, call: "sys.browser.profile.list", args: {} };
          else if (verb === "create" && value && options["--request-id"]) frame = { type: "req", id, call: "sys.browser.profile.create", args: { label: words.slice(2).join(" "), requestId: options["--request-id"] } };
          else if (verb === "save" && words.length === 3) frame = { type: "req", id, call: "sys.browser.profile.save", args: { instanceId: value } };
          else if ((verb === "get" || verb === "delete") && words.length === 3) frame = { type: "req", id, call: verb === "get" ? "sys.browser.profile.get" : "sys.browser.profile.delete", args: { profileId: value } };
          else throw new Error(help);
        } else if (group === "handoff") {
          if (verb === "request" && words.length === 4 && options["--request-id"] && options["--purpose"]) frame = { type: "req", id, call: "sys.browser.handoff.request", args: {
            instanceId: value, tabId: Number(tabOrRequest), requestId: options["--request-id"], purpose: options["--purpose"], responsibilityId: options["--work"],
          } };
          else if ((verb === "get" || verb === "cancel") && words.length === 4) frame = { type: "req", id, call: verb === "get" ? "sys.browser.handoff.get" : "sys.browser.handoff.cancel", args: { instanceId: value, requestId: tabOrRequest } };
          else throw new Error(help);
        } else throw new Error(help);
      }
      requireCommandCapability(ctx, frame.call);
      if (!request) throw new Error("Direct syscall transport is unavailable");
      const deadline = new AbortController();
      const timer = waitMs === undefined ? undefined : setTimeout(() => deadline.abort(new Error("Browser lifecycle wait timed out")), waitMs);
      const signal = shell.signal ? AbortSignal.any([shell.signal, deadline.signal]) : deadline.signal;
      try {
        const response = await request(frame, signal);
        if (!response.ok) throw new Error(response.error.message);
        await cancelBinaryBody(response.body, "Instance command returns metadata only");
        let data = response.data;
        // SAFETY: The transport pairs this response with the sys.instance.get request.
        if (frame.call === "sys.instance.get" && !(data as SysInstanceGetResult).instance) throw new Error("No instance has been admitted for this request ID");
        if (waitMs !== undefined) {
          // SAFETY: --wait is accepted for start and stop, whose paired responses contain an instance.
          const receipt = data as SysInstanceStartResult | SysInstanceGetResult;
          const stopping = frame.call === "sys.instance.stop";
          let current = receipt.instance;
          while (current && (stopping ? current.state === "stopping" : current.state === "starting")) {
            await waitForPoll(signal);
            const next = await request({ type: "req", id: crypto.randomUUID(), call: "sys.instance.get", args: { instanceId: current.instanceId } }, signal);
            if (!next.ok) throw new Error(next.error.message);
            await cancelBinaryBody(next.body, "Instance readiness returns metadata only");
            // SAFETY: The transport response is paired with the sys.instance.get request above.
            const observed = (next.data as SysInstanceGetResult).instance;
            if (!observed) throw new Error(`Instance ${current.targetId} is no longer available`);
            current = observed;
          }
          signal.throwIfAborted();
          if (current && (stopping ? current.state !== "stopped" && current.state !== "failed" : current.state !== "ready")) throw new Error(`Instance ${current.targetId} is ${current.state}${current.reason ? `: ${current.reason}` : ""}${current.diagnosticRef ? `; diagnostic ${current.diagnosticRef}` : ""}`);
          data = { ...receipt, instance: current };
        }
        return { stdout: `${JSON.stringify(data, null, 2)}\n`, stderr: "", exitCode: 0 };
      } catch (error) {
        if (signal.aborted && frame.call === "sys.instance.start") {
          const recoveryId = `'${frame.args.requestId.replaceAll("'", "'\\''")}'`;
          throw new Error(`${deadline.signal.aborted ? "Browser readiness wait timed out" : "Browser readiness wait cancelled"}. The instance was not stopped. Inspect with instance get --request-id ${recoveryId}; do not start again with a new ID.`, { cause: error });
        }
        throw error;
      } finally { clearTimeout(timer); }
    } catch (error) { return { stdout: "", stderr: `${name}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }; }
  }));
}
