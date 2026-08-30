import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("./probe.ts", import.meta.url));
const [{ text: bundle }] = (await build({
  bundle: true,
  entryPoints: [entry],
  format: "iife",
  platform: "browser",
  target: "chrome120",
  write: false,
})).outputFiles;

const server = createServer((request, response) => {
  if (request.url === "/probe.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(bundle);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<!doctype html><meta charset="utf-8"><body data-status="running"><script src="/probe.js"></script>');
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (address === null) throw new Error("browser probe server has no TCP address");
  // The server was opened with a TCP host and port, so Node cannot return a pipe-name string here.
  const tcpAddress = /** @type {import("node:net").AddressInfo} */ (address);
  const output = await runChromium(`http://127.0.0.1:${tcpAddress.port}/`);
  if (!output.includes('data-status="pass"')) {
    throw new Error(`Chromium probe failed:\n${output}`);
  }
  const result = output.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
  if (!result) throw new Error(`Chromium probe returned no result:\n${output}`);
  process.stdout.write(`${result}\n`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function runChromium(url) {
  return new Promise((resolve, reject) => {
    const chromium = spawn("chromium", [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--dump-dom",
      "--virtual-time-budget=5000",
      url,
    ]);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      chromium.kill("SIGKILL");
      reject(new Error("Chromium probe timed out"));
    }, 15_000);
    chromium.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    chromium.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    chromium.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    chromium.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Chromium exited ${code}: ${stderr}`));
    });
  });
}
