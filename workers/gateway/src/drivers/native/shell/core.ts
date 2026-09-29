import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { renderManualPage } from "../man-pages";
import {
  formatShellDiscoveryResults,
  type ShellDiscoveryCatalog,
} from "./discovery";

export function buildCoreCommands(
  fs: GsvFs,
  identity: ProcessIdentity,
  ctx: KernelContext,
  discovery: ShellDiscoveryCatalog,
) {
  const whoami = defineCommand("whoami", async (): Promise<ExecResult> => ({
    stdout: identity.username + "\n",
    stderr: "",
    exitCode: 0,
  }));

  const id = defineCommand("id", async (): Promise<ExecResult> => ({
    stdout: `uid=${identity.uid}(${identity.username}) gid=${identity.gid} groups=${identity.gids.join(",")}\n`,
    stderr: "",
    exitCode: 0,
  }));

  const hostname = defineCommand("hostname", async (): Promise<ExecResult> => ({
    stdout: (ctx.config.get("config/server/name") ?? "gsv") + "\n",
    stderr: "",
    exitCode: 0,
  }));

  const uname = defineCommand("uname", async (args): Promise<ExecResult> => {
    const name = ctx.config.get("config/server/name") ?? "gsv";
    const ver = ctx.config.get("config/server/version") ?? "0.1.6";
    const flag = args[0] ?? "";
    if (flag.includes("a") || flag === "-a") {
      return { stdout: `GSV ${name} ${ver} #1 cloudflare-worker\n`, stderr: "", exitCode: 0 };
    }
    if (flag.includes("r") || flag === "-r") {
      return { stdout: ver + "\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "GSV\n", stderr: "", exitCode: 0 };
  });

  const chown = defineCommand("chown", async (args): Promise<ExecResult> => {
    if (identity.uid !== 0) {
      return { stdout: "", stderr: "chown: Operation not permitted\n", exitCode: 1 };
    }
    if (args.length < 2) {
      return { stdout: "", stderr: "chown: missing operand\n", exitCode: 1 };
    }

    const ownerSpec = args[0];
    const targets = args.slice(1);

    const parts = ownerSpec.split(":");
    const newUid = parts[0] ? parseInt(parts[0], 10) : undefined;
    const newGid = parts.length > 1 && parts[1] ? parseInt(parts[1], 10) : undefined;

    if ((newUid !== undefined && isNaN(newUid)) || (newGid !== undefined && isNaN(newGid))) {
      return { stdout: "", stderr: `chown: invalid user: '${ownerSpec}'\n`, exitCode: 1 };
    }

    try {
      for (const target of targets) {
        await fs.chown(target, newUid, newGid);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `chown: ${msg}\n`, exitCode: 1 };
    }
  });

  const chmod = defineCommand("chmod", async (args): Promise<ExecResult> => {
    if (args.length < 2) {
      return { stdout: "", stderr: "chmod: missing operand\n", exitCode: 1 };
    }

    const modeStr = args[0];
    const targets = args.slice(1);
    const mode = parseInt(modeStr, 8);

    if (isNaN(mode) || mode < 0 || mode > 0o777) {
      return { stdout: "", stderr: `chmod: invalid mode: '${modeStr}'\n`, exitCode: 1 };
    }

    try {
      for (const target of targets) {
        await fs.chmod(target, mode);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `chmod: ${msg}\n`, exitCode: 1 };
    }
  });

  const ps = defineCommand("ps", async (): Promise<ExecResult> => {
    const procs = ctx.procs;
    if (!procs) {
      return { stdout: "PID\tSTATE\tLABEL\n", stderr: "", exitCode: 0 };
    }

    const list = procs.list();
    const lines = ["PID\tSTATE\tLABEL"];
    for (const proc of list) {
      lines.push(`${proc.processId}\t${proc.state}\t${proc.label ?? ""}`);
    }
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  });

  const man = defineCommand("man", async (args): Promise<ExecResult> => {
    const first = String(args[0] ?? "").trim();
    if (first === "--search" || first === "-k") {
      const json = args.includes("--json");
      const query = args
        .slice(1)
        .filter((arg) => arg !== "--" && arg !== "--json")
        .join(" ")
        .trim();
      if (!query) {
        return {
          stdout: "",
          stderr: "man: usage: man --search -- 'plain-language goal'\n",
          exitCode: 1,
        };
      }
      const matches = await discovery.search(query);
      return {
        stdout: json
          ? `${JSON.stringify({ query, matches }, null, 2)}\n`
          : formatShellDiscoveryResults(query, matches),
        stderr: "",
        exitCode: 0,
      };
    }

    if (!first || first === "help" || first === "--help" || first === "-h") {
      return {
        stdout: discovery.renderIndex(),
        stderr: "",
        exitCode: 0,
      };
    }

    const page = renderManualPage(first) ?? discovery.renderCommandManual(first);
    if (!page) {
      return {
        stdout: "",
        stderr: `man: no manual entry for ${first}\nTry: man --search -- ${quoteForMessage(first)}\n`,
        exitCode: 1,
      };
    }
    return {
      stdout: page.endsWith("\n") ? page : page + "\n",
      stderr: "",
      exitCode: 0,
    };
  });

  return [whoami, id, hostname, uname, chown, chmod, ps, man];
}

function quoteForMessage(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
