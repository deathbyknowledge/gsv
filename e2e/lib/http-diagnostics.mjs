import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CLASSIFIED_BODY_BYTES = 64 * 1024;
const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TRANSPORT_CLASSES = new Set([
  "ok",
  "dns",
  "connect",
  "response-transport",
  "http-error",
  "local-io",
  "timeout",
  "tls",
  "other",
]);
const CONTENT_TYPE_CLASSES = new Set([
  "missing",
  "malformed",
  "json",
  "html",
  "plain-text",
  "other-text",
  "binary-or-other",
]);
const RESPONSE_CLASSES = new Set([
  "empty",
  "oversized-unclassified",
  "expected-marker",
  "non-json",
  "json-non-object",
  "health-status-healthy",
  "health-status-ok",
  "health-status-other",
  "json-object-no-string-status",
]);

function integer(value, field, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${field} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function safeFileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function classifyContentType(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return "missing";
  }
  const mediaType = raw.split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    return "malformed";
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "json";
  }
  if (mediaType === "text/html") {
    return "html";
  }
  if (mediaType === "text/plain") {
    return "plain-text";
  }
  if (mediaType.startsWith("text/")) {
    return "other-text";
  }
  return "binary-or-other";
}

export function classifyCurlExit(code) {
  switch (integer(code, "curl exit code")) {
    case 0:
      return "ok";
    case 6:
      return "dns";
    case 7:
      return "connect";
    case 18:
    case 52:
    case 56:
      return "response-transport";
    case 22:
      return "http-error";
    case 23:
    case 26:
      return "local-io";
    case 28:
      return "timeout";
    case 35:
    case 51:
    case 58:
    case 60:
      return "tls";
    default:
      return "other";
  }
}

export function classifyHealthBody(raw, expectedMarker) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? "");
  if (body.length === 0) {
    return "empty";
  }
  if (body.length > MAX_CLASSIFIED_BODY_BYTES) {
    return "oversized-unclassified";
  }
  if (expectedMarker && body.includes(Buffer.from(expectedMarker))) {
    return "expected-marker";
  }

  let decoded;
  try {
    decoded = JSON.parse(body.toString("utf8"));
  } catch {
    return "non-json";
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return "json-non-object";
  }
  if (decoded.status === "healthy") {
    return "health-status-healthy";
  }
  if (decoded.status === "ok") {
    return "health-status-ok";
  }
  if (typeof decoded.status === "string") {
    return "health-status-other";
  }
  return "json-object-no-string-status";
}

export function parseCurlMetadata(raw) {
  const [statusRaw = "", contentTypeRaw = "", timeRaw = ""] = String(raw).split(/\r?\n/, 3);
  const status = /^[0-9]{3}$/.test(statusRaw.trim()) && statusRaw.trim() !== "000"
    ? Number(statusRaw.trim())
    : null;
  const timeSeconds = Number(timeRaw.trim());
  return {
    http_status: status,
    content_type: classifyContentType(contentTypeRaw),
    attempt_duration_ms: Number.isFinite(timeSeconds) && timeSeconds >= 0
      ? Math.round(timeSeconds * 1000)
      : null,
  };
}

export function buildHealthDiagnostic({
  endpoint,
  attempts,
  elapsedSeconds,
  curlExitCode,
  curlMetadata,
  body,
  bodyBytes,
  expectedMarker,
}) {
  if (!ENDPOINT_PATTERN.test(endpoint)) {
    throw new Error("endpoint label must be a short lowercase slug");
  }
  const response = classifyHealthBody(body, expectedMarker);
  return {
    schema_version: 1,
    endpoint,
    attempts: integer(attempts, "attempts", 1),
    elapsed_seconds: integer(elapsedSeconds, "elapsed seconds"),
    curl_exit_code: integer(curlExitCode, "curl exit code"),
    transport: classifyCurlExit(curlExitCode),
    ...parseCurlMetadata(curlMetadata),
    body_bytes: integer(bodyBytes, "body bytes"),
    response_class: response,
    expected_marker_present: response === "expected-marker",
  };
}

function retainedDiagnostic(diagnostic) {
  if (diagnostic?.schema_version !== 1) {
    throw new Error("health diagnostic schema_version must be 1");
  }
  if (!ENDPOINT_PATTERN.test(diagnostic.endpoint)) {
    throw new Error("health diagnostic endpoint is invalid");
  }
  if (!TRANSPORT_CLASSES.has(diagnostic.transport)) {
    throw new Error("health diagnostic transport class is invalid");
  }
  if (!CONTENT_TYPE_CLASSES.has(diagnostic.content_type)) {
    throw new Error("health diagnostic content type class is invalid");
  }
  if (!RESPONSE_CLASSES.has(diagnostic.response_class)) {
    throw new Error("health diagnostic response class is invalid");
  }
  const httpStatus = diagnostic.http_status === null
    ? null
    : integer(diagnostic.http_status, "HTTP status", 100);
  if (httpStatus !== null && httpStatus > 599) {
    throw new Error("HTTP status must be <= 599");
  }
  const attemptDuration = diagnostic.attempt_duration_ms === null
    ? null
    : integer(diagnostic.attempt_duration_ms, "attempt duration");
  return {
    schema_version: 1,
    endpoint: diagnostic.endpoint,
    attempts: integer(diagnostic.attempts, "attempts", 1),
    elapsed_seconds: integer(diagnostic.elapsed_seconds, "elapsed seconds"),
    curl_exit_code: integer(diagnostic.curl_exit_code, "curl exit code"),
    transport: diagnostic.transport,
    http_status: httpStatus,
    content_type: diagnostic.content_type,
    attempt_duration_ms: attemptDuration,
    body_bytes: integer(diagnostic.body_bytes, "body bytes"),
    response_class: diagnostic.response_class,
    expected_marker_present: diagnostic.expected_marker_present === true,
    recorded_at: new Date().toISOString(),
  };
}

export function recordHealthDiagnostic(path, diagnostic) {
  const retained = retainedDiagnostic(diagnostic);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(retained)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readOptional(path) {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
}

function main(args) {
  const [
    command,
    outputPath,
    endpoint,
    attempts,
    elapsedSeconds,
    curlExitCode,
    metadataPath,
    bodyPath,
    expectedMarker,
  ] = args;
  if (command !== "record") {
    throw new Error("usage: http-diagnostics.mjs record OUTPUT ENDPOINT ATTEMPTS ELAPSED CURL_EXIT META BODY EXPECTED");
  }
  const metadata = readOptional(metadataPath).toString("utf8");
  const bodyBytes = safeFileSize(bodyPath);
  const body = bodyBytes <= MAX_CLASSIFIED_BODY_BYTES
    ? readOptional(bodyPath)
    : Buffer.alloc(MAX_CLASSIFIED_BODY_BYTES + 1);
  const diagnostic = buildHealthDiagnostic({
    endpoint,
    attempts,
    elapsedSeconds,
    curlExitCode,
    curlMetadata: metadata,
    body,
    bodyBytes,
    expectedMarker,
  });
  recordHealthDiagnostic(outputPath, diagnostic);
  console.log(
    `Health diagnostic: endpoint=${diagnostic.endpoint} attempts=${diagnostic.attempts} `
      + `transport=${diagnostic.transport} http=${diagnostic.http_status ?? "none"} `
      + `content=${diagnostic.content_type} body=${diagnostic.response_class} `
      + `bytes=${diagnostic.body_bytes}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
