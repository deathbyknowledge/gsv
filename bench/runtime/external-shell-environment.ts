import { spawn } from "node:child_process";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import {
  SyntheticCapabilityEnvironment,
  type SyntheticCapabilityCall,
  type SyntheticInvocationResult,
} from "./environment";
import type { SyntheticTargetSpec } from "./schema";

const shellArgsSchema = z.object({
  input: z.string(),
}).passthrough();

export type ExternalShellCommand = {
  executable: string;
  arguments: string[];
};

export abstract class ExternalShellEnvironment extends SyntheticCapabilityEnvironment {
  private commandsExecuted = 0;

  protected constructor(
    spec: SyntheticTargetSpec,
    private readonly timeoutMs: number,
    private readonly maxOutputBytes = 4 * 1024 * 1024,
  ) {
    super({
      ...spec,
      implements: spec.implements ?? ["shell.exec"],
      files: {},
      commands: {},
    });
  }

  protected abstract shellCommand(input: string): ExternalShellCommand;

  override async invoke(
    call: SyntheticCapabilityCall,
    args: JsonObject,
  ): Promise<SyntheticInvocationResult> {
    if (call !== "shell.exec") return super.invoke(call, args);
    const parsed = shellArgsSchema.safeParse(args);
    if (!parsed.success) {
      return shellFailure("Invalid shell.exec arguments", "", 2);
    }
    const command = this.shellCommand(parsed.data.input);
    const result = await runCaptured(
      command,
      this.timeoutMs,
      this.maxOutputBytes,
    );
    this.commandsExecuted += 1;
    this.setState("commandsExecuted", this.commandsExecuted);
    const output = result.stdout + result.stderr;
    if (result.timedOut) {
      return shellFailure(
        "Command timed out after " + this.timeoutMs + "ms",
        output,
        124,
      );
    }
    if (result.outputLimited) {
      return shellFailure(
        "Command exceeded the output limit of " + this.maxOutputBytes + " bytes",
        output,
        125,
      );
    }
    return result.exitCode === 0
      ? {
        value: { status: "completed", output, exitCode: 0, ok: true },
        isError: false,
      }
      : shellFailure(
        output.trim() || "Command exited with code " + result.exitCode,
        output,
        result.exitCode,
      );
  }
}

type CapturedResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimited: boolean;
};

function runCaptured(
  command: ExternalShellCommand,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<CapturedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.arguments, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputLimited = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    const collect = (destination: Buffer[], chunk: Buffer): void => {
      if (outputLimited) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputLimited = true;
        child.kill("SIGKILL");
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputLimited,
      });
    });
  });
}

function shellFailure(
  error: string,
  output: string,
  exitCode: number,
): SyntheticInvocationResult {
  return {
    value: {
      status: "failed",
      output,
      error,
      exitCode,
      ok: true,
    },
    isError: true,
  };
}
