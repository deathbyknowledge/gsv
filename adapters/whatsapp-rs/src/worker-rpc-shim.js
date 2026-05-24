import * as imports from "./index_bg.js";
export * from "./index_bg.js";
import wasmModule from "./index.wasm";
import { WorkerEntrypoint } from "cloudflare:workers";
$SNIPPET_JS_IMPORTS

const instance = new WebAssembly.Instance(wasmModule, {
  "./index_bg.js": imports,
  $SNIPPET_WASM_IMPORTS
});

imports.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start?.();

export { wasmModule };

const CONTEXT_EXPORTS = new Set([
  "adapterConnect",
  "adapterDisconnect",
  "adapterSend",
  "adapterSetActivity",
  "adapterShellExec",
  "adapterStatus",
]);

class Entrypoint extends WorkerEntrypoint {
  async fetch(request) {
    const response = imports.fetch(request, this.env, this.ctx);
    $WAIT_UNTIL_RESPONSE;
    return await response;
  }
}

const QUEUE_EXPORT = "queue";
const SCHEDULED_EXPORT = "scheduled";

if (typeof imports[QUEUE_EXPORT] === "function") {
  Entrypoint.prototype.queue = async function (batch) {
    return await imports[QUEUE_EXPORT](batch, this.env, this.ctx);
  };
}

if (typeof imports[SCHEDULED_EXPORT] === "function") {
  Entrypoint.prototype.scheduled = async function (event) {
    return await imports[SCHEDULED_EXPORT](event, this.env, this.ctx);
  };
}

const EXCLUDE_EXPORT = [
  "IntoUnderlyingByteSource",
  "IntoUnderlyingSink",
  "IntoUnderlyingSource",
  "MinifyConfig",
  "PolishConfig",
  "R2Range",
  "RequestRedirect",
  "fetch",
  "queue",
  "scheduled",
  "getMemory",
];

Object.keys(imports).forEach((key) => {
  if (EXCLUDE_EXPORT.includes(key) || key.startsWith("__")) {
    return;
  }
  if (CONTEXT_EXPORTS.has(key)) {
    Entrypoint.prototype[key] = function (...args) {
      return imports[key](...args, this.env, this.ctx);
    };
    return;
  }
  Entrypoint.prototype[key] = imports[key];
});

export { Entrypoint as WhatsAppChannelEntrypoint };
export default Entrypoint;
