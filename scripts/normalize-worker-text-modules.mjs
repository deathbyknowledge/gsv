import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";
import MagicString from "magic-string";
import { SourceMapConsumer, SourceMapGenerator } from "source-map-js";

/**
 * Preserve Wrangler Text imports when the prebuilt uploader classifies modules by extension.
 * @param {string} directory
 */
export async function normalizeWorkerTextModules(directory) {
  await init;
  const root = resolve(directory);
  const renames = new Map();
  const edits = [];
  for (const name of readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => /\.m?js$/.test(name))) {
    const file = resolve(root, name);
    const source = readFileSync(file, "utf8");
    const modified = new MagicString(source);
    let changed = false;
    for (const entry of parse(source)[0]) {
      if (!entry.n?.endsWith(".md")) continue;
      if (!entry.n.startsWith("./") && !entry.n.startsWith("../")) {
        throw new Error("Text modules must use relative imports");
      }
      const original = resolve(dirname(file), entry.n);
      const scoped = relative(root, original);
      if (isAbsolute(scoped) || scoped === ".." || scoped.startsWith(`..${sep}`)) {
        throw new Error("Text module is outside the Worker bundle");
      }
      const target = `${original.slice(0, -3)}.txt`;
      if (!existsSync(original) || existsSync(target)) throw new Error("Text module is missing or its normalized name is occupied");
      renames.set(original, target);
      const specifier = `${entry.n.slice(0, -3)}.txt`;
      modified.overwrite(entry.s, entry.e, entry.d === -1 ? specifier : JSON.stringify(specifier));
      changed = true;
    }
    if (!changed) continue;
    const mapReference = /^\/\/[#@] sourceMappingURL=(\S+)\s*$/m.exec(source)?.[1];
    let map;
    if (mapReference) {
      if (mapReference !== `${basename(file)}.map`) throw new Error("Expected an adjacent Worker source map");
      const originalMap = new SourceMapConsumer(JSON.parse(readFileSync(`${file}.map`, "utf8")));
      const editMap = new SourceMapConsumer(JSON.parse(modified.generateMap({ source: basename(file), file: basename(file), hires: true }).toString()));
      const composed = SourceMapGenerator.fromSourceMap(editMap);
      composed.applySourceMap(originalMap, basename(file));
      map = composed.toString();
    }
    edits.push({ file, source: modified.toString(), map });
  }
  // Validate the entire bundle before replacing any output. Prompt source files are never changed.
  for (const [original, target] of renames) renameSync(original, target);
  for (const edit of edits) {
    writeFileSync(edit.file, edit.source);
    if (edit.map) writeFileSync(`${edit.file}.map`, edit.map);
  }
  return { modules: renames.size, entries: edits.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: normalize-worker-text-modules.mjs <worker-directory>");
  await normalizeWorkerTextModules(process.argv[2]);
}
