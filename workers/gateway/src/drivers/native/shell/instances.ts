import { defineCommand } from "just-bash";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import type { RequestFrame } from "../../../protocol/frames";
import type { NativeShellCommandOptions } from "./commands";
import { requireCommandCapability, requireShellOptionValue } from "./common";

const INSTANCE_HELP = `Usage:
  instance catalog
  instance start browser --request-id ID [--new] [--profile ID] [--name NAME] [--seconds N]
  instance list [--all]
  instance get ID | instance get --request-id ID
  instance stop ID | instance stop --request-id ID

Keep the request ID before starting. If the response is lost, get by that ID; do not start again with a new ID.
Start reuses your current browser, including one still starting, without extending its lifetime. Use another tab for additional work.
--new explicitly starts a separate, temporary browser. Ordinary starts remember logins for your account automatically.
Instances have a fixed lifetime. Stop them when finished. A stopped instance never restarts.
`;
const BROWSER_HELP = `Usage:
  browser profile list
  browser profile create NAME --request-id ID
  browser profile get ID
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
    options[arg] = arg === "--all" || arg === "--new" ? "true" : requireShellOptionValue(args[++i], arg);
  }
  return { words, options };
}

export function buildInstanceCommands(ctx: KernelContext, request?: NativeShellCommandOptions["request"]) {
  return ["instance", "browser"].map(name => defineCommand(name, async (argv, shell) => {
    const help = name === "instance" ? INSTANCE_HELP : BROWSER_HELP;
    if (!argv.length || argv.includes("--help") || argv.includes("-h")) return { stdout: help, stderr: "", exitCode: 0 };
    try {
      let frame: RequestFrame;
      const id = crypto.randomUUID();
      if (name === "instance") {
        const { words, options } = parseOptions(argv, ["--request-id", "--profile", "--name", "--seconds", "--all", "--new"]);
        const [verb, target] = words;
        if (verb === "catalog" && words.length === 1) frame = { type: "req", id, call: "sys.instance.catalog", args: {} };
        else if (verb === "list" && words.length === 1) frame = { type: "req", id, call: "sys.instance.list", args: { includeTerminal: options["--all"] === "true" } };
        else if ((verb === "get" || verb === "stop") && (target || options["--request-id"])) {
          if (target && options["--request-id"]) throw new Error("Choose either an instance ID or --request-id");
          frame = { type: "req", id, call: verb === "get" ? "sys.instance.get" : "sys.instance.stop", args: target ? { instanceId: target } : { startRequestId: options["--request-id"] } };
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
      const response = await request(frame, shell.signal);
      if (!response.ok) throw new Error(response.error.message);
      await cancelBinaryBody(response.body, "Instance command returns metadata only");
      return { stdout: `${JSON.stringify(response.data, null, 2)}\n`, stderr: "", exitCode: 0 };
    } catch (error) { return { stdout: "", stderr: `${name}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }; }
  }));
}
