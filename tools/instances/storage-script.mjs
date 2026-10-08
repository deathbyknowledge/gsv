import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { collectBrowserStorage, encodeBrowserBinary } from "./storage-collection.mjs";

// Keep the browser-side codec from the pinned Playwright release. This backports
// https://github.com/microsoft/playwright/pull/42260 without changing node_modules.
export function closeStorageConnections(source) {
  for (const [start, end] of [["  async _collectDB(dbInfo) {", "  async collect(recordIndexedDB) {"], ["  async _restoreDB(dbInfo) {", "  async restore(originState) {"]]) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    if (first < 0 || last < 0) throw new Error("Playwright storage codec changed; review the connection cleanup backport");
    const method = source.slice(first, last);
    const declaration = method.indexOf("    const db = await ");
    const body = method.indexOf("\n", declaration) + 1;
    const close = method.lastIndexOf("  }");
    if (declaration < 0 || close < body) throw new Error("Playwright database ownership changed");
    const patched = `${method.slice(0, body)}    try {\n${method.slice(body, close)}    } finally { db.close(); }\n${method.slice(close)}`;
    source = source.slice(0, first) + patched + source.slice(last);
  }
  return source;
}

// Extend only the browser-side codec, using the same version for export and
// restore. Unsupported structured-clone values must never become empty objects.
export function storageCodec(source) {
  source = closeStorageConnections(source);
  const replace = (before, after) => {
    if (!source.includes(before)) throw new Error("Playwright storage codec changed; review the structured-clone support");
    source = source.replace(before, after);
  };
  replace('  const binary = Array.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).map((b) => String.fromCharCode(b)).join("");\n  return btoa(binary);', `  return (${encodeBrowserBinary.toString()})(array);`);
  replace('    if ("a" in value) {', `    if ("ab" in value) return base64ToTypedArray(value.ab, Uint8Array).buffer;
    if ("dv" in value) return new DataView(base64ToTypedArray(value.dv, Uint8Array).buffer);
    if ("m" in value || "s" in value) {
      const result = "m" in value ? new Map() : new Set();
      refs.set(value.id, result);
      if ("m" in value) for (const [k, v] of value.m) result.set(parseEvaluationResultValue(k, handles, refs), parseEvaluationResultValue(v, handles, refs));
      else for (const v of value.s) result.add(parseEvaluationResultValue(v, handles, refs));
      return result;
    }
    if ("a" in value) {`);
  replace('  if (Array.isArray(value)) {', `  if (value instanceof ArrayBuffer) return { ab: typedArrayToBase64(new Uint8Array(value)) };
  if (value instanceof DataView) return { dv: typedArrayToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (value instanceof Map || value instanceof Set) {
    const id = ++visitorInfo.lastId;
    visitorInfo.visited.set(value, id);
    const encode = v => serialize(v, handleSerializer, visitorInfo);
    const items = [];
    if (value instanceof Map) { for (const [k, v] of value) items.push([encode(k), encode(v)]); return { m: items, id }; }
    for (const v of value) items.push(encode(v));
    return { s: items, id };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error("Unsupported IndexedDB value type: " + Object.prototype.toString.call(value));
  if (Array.isArray(value)) {`);
  replace('    let trivial = true;', '    let trivial = true;\n    const seen = new Set();');
  replace('typeof v === "number" ||', '(typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0)) ||');
  replace('      if (!isTrivial)', `      if (v && typeof v === "object") {
        if (seen.has(v)) trivial = false;
        seen.add(v);
      }
      if (!isTrivial)`);
  replace('    if (trivial)\n      return { trivial: value };', '    if (trivial && value)\n      return { trivial: value };');
  // Request success precedes transaction commit. A quota/commit failure must
  // reject restore before the browser becomes ready.
  replace('    const transaction = db.transaction(db.objectStoreNames, "readwrite");', `    const transaction = db.transaction(db.objectStoreNames, "readwrite");
    const committed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB restore aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB restore failed"));
    });
    committed.catch(() => {});`);
  replace('    } finally { db.close(); }\n  }\n  async restore(originState)', '    await committed;\n    } finally { db.close(); }\n  }\n  async restore(originState)');
  const first = source.indexOf("  async _collectDB(dbInfo) {"), last = source.indexOf("  async _restoreDB(dbInfo) {", first);
  if (first < 0 || last < 0) throw new Error("Playwright storage collection changed; review the bounded collector");
  const collect = collectBrowserStorage.toString().replace("async function collectBrowserStorage(", "async collect(");
  return source.slice(0, first) + `  ${collect}\n` + source.slice(last);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { source } = await import("../../node_modules/@cloudflare/playwright/lib/playwright-core/src/generated/storageScriptSource.js");
  const packageJson = JSON.parse(await readFile(new URL("../../node_modules/@cloudflare/playwright/package.json", import.meta.url), "utf8"));
  if (packageJson.version !== "1.3.6") throw new Error("Review the browser storage codec when upgrading @cloudflare/playwright");
  const output = `// Generated by tools/instances/storage-script.mjs from @cloudflare/playwright 1.3.6.\n// Copyright Microsoft Corporation. Licensed under Apache-2.0; see playwright-storage.LICENSE.\n// Includes microsoft/playwright#42260 and GSV structured-clone fidelity checks.\nexport const storageScriptSource = ${JSON.stringify(storageCodec(source))};\n`;
  const target = new URL("../../workers/instances/src/playwright-storage.generated.ts", import.meta.url);
  if (process.argv.includes("--check")) {
    if (await readFile(target, "utf8") !== output) throw new Error("Browser storage codec is stale; run node tools/instances/storage-script.mjs");
  } else await writeFile(target, output);
}
