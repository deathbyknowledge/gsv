import {
  acquireDebugger,
  releaseDebugger,
  sendDebuggerCommand,
} from "../shared/debugger";

const DEBUGGER_EVALUATE_TIMEOUT_MS = 30_000;

type RuntimeRemoteObject = {
  type?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
};

type RuntimeExceptionDetails = {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: RuntimeRemoteObject;
};

type RuntimeEvaluateResult = {
  result?: RuntimeRemoteObject;
  exceptionDetails?: RuntimeExceptionDetails;
};

type JavaScriptResult = { ok: true; value: unknown } | { ok: false; error: string };

const DEBUGGER_SERIALIZER_FUNCTION = String.raw`function() {
  function summarizeElement(element) {
    const rect = element.getBoundingClientRect();
    const attrs = {};
    for (const name of ["id", "role", "aria-label", "name", "type", "href", "title"]) {
      const value = element.getAttribute(name);
      if (value) {
        attrs[name] = value;
      }
    }
    return {
      tag: element.tagName.toLowerCase(),
      text: ((element.innerText || element.textContent || "")).replace(/\s+/g, " ").trim().slice(0, 160),
      attrs,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function serialize(value, depth, seen) {
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      return value.length > 5000 ? value.slice(0, 4999) + "..." : value;
    }
    if (typeof value === "undefined") {
      return { type: "undefined" };
    }
    if (typeof value === "bigint") {
      return { type: "bigint", value: value.toString() };
    }
    if (typeof value === "symbol") {
      return { type: "symbol", value: String(value) };
    }
    if (typeof value === "function") {
      return { type: "function", name: value.name || undefined };
    }
    if (value instanceof Error) {
      return {
        type: "error",
        name: value.name,
        message: value.message,
        stack: value.stack ? value.stack.slice(0, 2000) : undefined
      };
    }
    if (value instanceof Element) {
      return { type: "element", ...summarizeElement(value) };
    }
    if (value instanceof Node) {
      return {
        type: "node",
        nodeType: value.nodeType,
        nodeName: value.nodeName,
        text: (value.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)
      };
    }
    if (typeof value !== "object") {
      return String(value);
    }
    if (seen.indexOf(value) >= 0) {
      return { type: "circular" };
    }
    if (depth >= 4) {
      return { type: Array.isArray(value) ? "array" : "object", truncated: true };
    }

    const nextSeen = seen.concat([value]);
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        items: value.slice(0, 50).map((item) => serialize(item, depth + 1, nextSeen)),
        truncatedItems: Math.max(0, value.length - 50)
      };
    }

    const keys = Object.keys(value);
    const objectValue = {};
    for (const key of keys.slice(0, 50)) {
      try {
        objectValue[key] = serialize(value[key], depth + 1, nextSeen);
      } catch (error) {
        objectValue[key] = { type: "thrown", error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (keys.length > 50) {
      objectValue.truncatedKeys = keys.length - 50;
    }
    return objectValue;
  }

  return serialize(this, 0, []);
}`;

export async function evaluatePageJavaScript(tabId: number, source: string): Promise<JavaScriptResult> {
  let target: chrome.debugger.DebuggerSession | null = null;
  try {
    target = await acquireDebugger(tabId);
    await sendDebuggerCommand(target, "Runtime.enable");

    let result = await runtimeEvaluate(target, source);
    if (isSyntaxException(result.exceptionDetails)) {
      const syncWrapped = await runtimeEvaluate(target, `(() => {\n${source}\n})()`);
      if (!syncWrapped.exceptionDetails || !isSyntaxException(syncWrapped.exceptionDetails)) {
        result = syncWrapped;
      } else {
        result = await runtimeEvaluate(target, `(async () => {\n${source}\n})()`);
      }
    }
    if (isSyntaxException(result.exceptionDetails)) {
      const parenthesized = await runtimeEvaluate(target, `(${source})`);
      if (!parenthesized.exceptionDetails) {
        result = parenthesized;
      }
    }
    if (result.exceptionDetails) {
      return { ok: false, error: formatRuntimeException(result.exceptionDetails) };
    }
    if (!result.result) {
      return { ok: false, error: "Runtime.evaluate returned no result" };
    }
    return {
      ok: true,
      value: { result: await serializeRuntimeRemoteObject(target, result.result) },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (target) {
      await releaseDebugger(tabId).catch((error: unknown) => {
        console.warn("GSV browser target failed to detach debugger", error);
      });
    }
  }
}

async function runtimeEvaluate(
  target: chrome.debugger.DebuggerSession,
  expression: string,
): Promise<RuntimeEvaluateResult> {
  return await sendDebuggerCommand<RuntimeEvaluateResult>(target, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: false,
    generatePreview: true,
    userGesture: true,
    timeout: DEBUGGER_EVALUATE_TIMEOUT_MS,
    replMode: true,
  });
}

async function serializeRuntimeRemoteObject(
  target: chrome.debugger.DebuggerSession,
  remote: RuntimeRemoteObject,
): Promise<unknown> {
  if (!remote.objectId) {
    return remoteObjectLiteral(remote);
  }
  try {
    const raw = await sendDebuggerCommand<RuntimeEvaluateResult>(target, "Runtime.callFunctionOn", {
      objectId: remote.objectId,
      functionDeclaration: DEBUGGER_SERIALIZER_FUNCTION,
      returnByValue: true,
      silent: true,
    });
    if (raw.exceptionDetails) {
      return {
        type: remote.type ?? "object",
        subtype: remote.subtype,
        className: remote.className,
        description: remote.description,
        serializationError: formatRuntimeException(raw.exceptionDetails),
      };
    }
    return raw.result ? remoteObjectLiteral(raw.result) : remoteObjectLiteral(remote);
  } finally {
    await sendDebuggerCommand(target, "Runtime.releaseObject", {
      objectId: remote.objectId,
    }).catch(() => undefined);
  }
}

function remoteObjectLiteral(remote: RuntimeRemoteObject): unknown {
  if (Object.prototype.hasOwnProperty.call(remote, "value")) {
    return remote.value;
  }
  if (remote.unserializableValue) {
    return { type: remote.type ?? "unserializable", value: remote.unserializableValue };
  }
  if (remote.type === "undefined") {
    return { type: "undefined" };
  }
  return Object.fromEntries(Object.entries({
    type: remote.type,
    subtype: remote.subtype,
    className: remote.className,
    description: remote.description,
  }).filter(([, value]) => value !== undefined));
}

function formatRuntimeException(details: RuntimeExceptionDetails): string {
  const remote = details.exception;
  const message = String(
    remote?.description
      ?? remote?.value
      ?? details.text
      ?? "JavaScript evaluation failed",
  );
  const location = typeof details.lineNumber === "number" && typeof details.columnNumber === "number"
    ? ` at ${details.lineNumber + 1}:${details.columnNumber + 1}`
    : "";
  return `${message}${location}`;
}

function isSyntaxException(details: RuntimeExceptionDetails | undefined): boolean {
  const remote = details?.exception;
  return remote?.className === "SyntaxError"
    || remote?.description?.startsWith("SyntaxError") === true
    || String(remote?.value ?? details?.text ?? "").startsWith("SyntaxError");
}
