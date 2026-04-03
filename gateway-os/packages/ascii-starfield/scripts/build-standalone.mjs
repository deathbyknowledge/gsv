import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const htmlEntrypoint = path.join(root, "src/ascii-starfield.html");
const workerEntrypoint = path.join(root, "src/ascii-starfield.ts");
const outputDir = path.join(root, "ui");
const outputHtmlPath = path.join(outputDir, "index.html");
const outputWorkerPath = path.join(outputDir, "ascii-starfield-worker.js");
const tempDir = await mkdtemp(path.join(tmpdir(), "gsv-ascii-starfield-"));
const bunExecutable = process.execPath;

try {
  const htmlResult = Bun.spawnSync(
    [bunExecutable, "build", htmlEntrypoint, "--outdir", tempDir, "--minify"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (htmlResult.exitCode !== 0) process.exit(htmlResult.exitCode ?? 1);

  const workerResult = Bun.spawnSync(
    [bunExecutable, "build", workerEntrypoint, "--outfile", path.join(tempDir, "ascii-starfield-worker.js"), "--minify"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (workerResult.exitCode !== 0) process.exit(workerResult.exitCode ?? 1);

  const htmlPath = path.join(tempDir, "ascii-starfield.html");
  const html = await readFile(htmlPath, "utf8");
  const bundleNames = (await readdir(tempDir)).filter(name => name.endsWith(".js") && name !== "ascii-starfield-worker.js");
  if (bundleNames.length !== 1) {
    throw new Error(`Expected exactly one main JS bundle, found ${bundleNames.length}`);
  }

  const mainBundlePath = path.join(tempDir, bundleNames[0]);
  const mainBundle = await readFile(mainBundlePath, "utf8");
  const patchedMainBundle = mainBundle.replace(
    /new URL\("\.\/ascii-starfield\.ts",\s*import\.meta\.url\)/,
    'new URL("./ascii-starfield-worker.js", import.meta.url)',
  );
  if (patchedMainBundle === mainBundle) {
    throw new Error("Failed to rewrite the worker URL in the main bundle");
  }

  const escapedMainBundle = patchedMainBundle.replaceAll("</script", "<\\/script");
  const portableHtml = html.replace(
    /<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/,
    () => `<script type="module">\n${escapedMainBundle}\n</script>`,
  );
  if (portableHtml === html) {
    throw new Error("Failed to inline the main bundle into the HTML output");
  }
  if ((portableHtml.match(/<script\b/g) ?? []).length !== 1) {
    throw new Error("Portable HTML still contains unexpected external script tags");
  }

  const workerBundle = await readFile(path.join(tempDir, "ascii-starfield-worker.js"), "utf8");

  await mkdir(outputDir, { recursive: true });
  const existingEntries = await readdir(outputDir);
  for (let index = 0; index < existingEntries.length; index += 1) {
    const entry = existingEntries[index];
    if (entry === "worker.ts") continue;
    await rm(path.join(outputDir, entry), { recursive: true, force: true });
  }
  await writeFile(outputHtmlPath, portableHtml);
  await writeFile(outputWorkerPath, workerBundle);

  console.log(`Wrote portable demo to ${path.relative(root, outputDir)}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
