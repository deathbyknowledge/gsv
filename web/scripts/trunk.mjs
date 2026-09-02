import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const environment = { ...process.env };
delete environment.NO_COLOR;
const tuiDirectory = fileURLToPath(new URL("../tui/", import.meta.url));

const child = spawn("trunk", process.argv.slice(2), {
  cwd: tuiDirectory,
  env: environment,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
