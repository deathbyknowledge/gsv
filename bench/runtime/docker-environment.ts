import { z } from "zod";
import {
  ExternalShellEnvironment,
  type ExternalShellCommand,
} from "./external-shell-environment";
import type { SyntheticTargetSpec } from "./schema";

const configSchema = z.object({
  container: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
  workdir: z.string().startsWith("/").default("/app"),
  timeoutMs: z.number().int().positive().max(15 * 60_000).default(120_000),
}).strict();

export class DockerExecEnvironment extends ExternalShellEnvironment {
  private readonly container: string;
  private readonly workdir: string;

  constructor(spec: SyntheticTargetSpec) {
    if (spec.driver !== "docker-exec") {
      throw new Error("DockerExecEnvironment requires driver docker-exec");
    }
    const config = configSchema.parse(spec.driverConfig);
    super(spec, config.timeoutMs);
    this.container = config.container;
    this.workdir = config.workdir;
  }

  protected shellCommand(input: string): ExternalShellCommand {
    return {
      executable: "docker",
      arguments: [
        "exec",
        "-i",
        "-w",
        this.workdir,
        this.container,
        "sh",
        "-lc",
        input,
      ],
    };
  }
}
