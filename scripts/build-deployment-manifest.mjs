import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadAdapterCatalog } from "./adapter-catalog.mjs";

const output = resolve(process.argv[2] ?? "dist/cloudflare/deployment-manifest.json");
const runtime = JSON.parse(
  await readFile(new URL("../deployment/runtime.json", import.meta.url), "utf8"),
);
const catalog = await loadAdapterCatalog();
const manifest = {
  ...runtime,
  adapters: catalog.adapters.map((adapter) => {
    const deployment = {
      id: adapter.id,
      displayName: adapter.displayName,
      gatewayBinding: adapter.gatewayBinding,
      deployment: { ...adapter.deployment, main: `dist/cloudflare/${adapter.component}/worker/index.js`, bundle: false },
    };
    return deployment;
  }),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
