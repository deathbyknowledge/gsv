import { z } from "zod";
import {
  ExternalShellEnvironment,
  type ExternalShellCommand,
} from "./external-shell-environment";
import type { SyntheticTargetSpec } from "./schema";

const configSchema = z.object({
  sandbox: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  workdir: z.string().startsWith("/").default("/app"),
  timeoutMs: z.number().int().positive().max(15 * 60_000).default(120_000),
}).strict();

export class PrimeSandboxEnvironment extends ExternalShellEnvironment {
  private readonly sandbox: string;
  private readonly workdir: string;

  constructor(spec: SyntheticTargetSpec) {
    if (spec.driver !== "prime-sandbox") {
      throw new Error("PrimeSandboxEnvironment requires driver prime-sandbox");
    }
    const config = configSchema.parse(spec.driverConfig);
    super(spec, config.timeoutMs);
    this.sandbox = config.sandbox;
    this.workdir = config.workdir;
  }

  protected shellCommand(input: string): ExternalShellCommand {
    return {
      executable: "prime",
      arguments: [
        "--plain",
        "sandbox",
        "run",
        this.sandbox,
        "--working-dir",
        this.workdir,
        "--timeout",
        "900",
        "--",
        "sh",
        "-lc",
        input,
      ],
    };
  }
}
