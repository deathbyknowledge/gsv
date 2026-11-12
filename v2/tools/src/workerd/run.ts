import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { Build } from "../build.ts";

/** The pinned binary: each release runs the workerd version it was tested on. */
const workerdPath = (createRequire(import.meta.url)("workerd") as { default: string }).default;

export type Workerd = { process: ChildProcess; origin: string; exited: Promise<number | null>; stop(): Promise<void> };

/** Starts a compiled build on local workerd and resolves once it answers HTTP. */
export async function startWorkerd(build: Build, opts: {
  data: string;
  port: number;
  env: Record<string, string>;
  /** Show workerd's output; otherwise it is kept for the error when startup fails. */
  inherit?: boolean;
}): Promise<Workerd> {
  const child = spawn(workerdPath, [
    "serve", build.workerd,
    "--directory-path", `gsv-data=${opts.data}`,
    "--directory-path", `gsv-ui=${build.ui}`,
    "--socket-addr", `http=*:${opts.port}`,
  ], { env: { ...process.env, ...opts.env }, stdio: opts.inherit ? "inherit" : "pipe" });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const origin = `http://localhost:${opts.port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`workerd exited with ${child.exitCode ?? child.signalCode}\n${output}`);
    try {
      await (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).body?.cancel();
      return { process: child, origin, exited, stop };
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`workerd didn't answer on port ${opts.port}\n${output}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
