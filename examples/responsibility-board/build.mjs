import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = new URL("./", import.meta.url);
const output = new URL("dist/", directory);
await mkdir(output, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL("app.ts", directory))], outfile: fileURLToPath(new URL("app.js", output)),
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2022" });
await Promise.all(["index.html", "style.css"].map(name => copyFile(new URL(name, directory), new URL(name, output))));
