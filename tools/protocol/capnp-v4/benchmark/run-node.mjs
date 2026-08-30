import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./node.ts", import.meta.url));
const [{ text: bundle }] = (await build({
  bundle: true,
  entryPoints: [entry],
  format: "esm",
  platform: "node",
  target: "node24",
  write: false,
})).outputFiles;

await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
