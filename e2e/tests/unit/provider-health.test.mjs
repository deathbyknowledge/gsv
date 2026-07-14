import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

test("mock provider health contract matches runner readiness", { timeout: 10_000 }, async () => {
  const port = await freePort();
  const provider = spawn(
    "python3",
    [
      fileURLToPath(new URL("../../../scripts/mock-openai-provider.py", import.meta.url)),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--shell-target",
      "gsv-e2e-health-runner",
    ],
    { stdio: "ignore" },
  );

  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) {
          assert.deepEqual(await response.json(), { status: "ok", model: "gsv-mock" });
          return;
        }
      } catch {
        // The child has not bound its socket yet.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.fail("mock provider did not expose its health contract");
  } finally {
    const exited = provider.exitCode === null ? once(provider, "exit") : Promise.resolve();
    provider.kill("SIGTERM");
    let exitTimer;
    await Promise.race([
      exited,
      new Promise((resolveDelay) => {
        exitTimer = setTimeout(resolveDelay, 1_000);
      }),
    ]);
    clearTimeout(exitTimer);
    if (provider.exitCode === null) {
      provider.kill("SIGKILL");
    }
  }
});
