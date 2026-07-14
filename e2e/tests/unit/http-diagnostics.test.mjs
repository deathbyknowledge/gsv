import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHealthDiagnostic,
  classifyContentType,
  classifyCurlExit,
  classifyHealthBody,
  parseCurlMetadata,
  recordHealthDiagnostic,
} from "../../lib/http-diagnostics.mjs";

test("classifies health bodies without retaining status values or content", () => {
  assert.equal(
    classifyHealthBody('{"status":"healthy"}', '"status":"healthy"'),
    "expected-marker",
  );
  assert.equal(
    classifyHealthBody('{"status": "healthy"}', '"status":"healthy"'),
    "health-status-healthy",
  );
  assert.equal(
    classifyHealthBody('{"status":"ok"}', '"status":"healthy"'),
    "health-status-ok",
  );
  assert.equal(
    classifyHealthBody('{"status":"private-value"}', '"status":"healthy"'),
    "health-status-other",
  );
  assert.equal(classifyHealthBody("<private html>", '"status":"healthy"'), "non-json");
  assert.equal(
    classifyHealthBody(Buffer.alloc((64 * 1024) + 1), '"status":"healthy"'),
    "oversized-unclassified",
  );
});

test("reduces headers and curl outcomes to fixed allowlisted classes", () => {
  assert.equal(classifyContentType("application/problem+json; charset=utf-8"), "json");
  assert.equal(classifyContentType("text/html; private=do-not-retain"), "html");
  assert.equal(classifyContentType("private header material"), "malformed");
  assert.equal(classifyCurlExit(28), "timeout");
  assert.equal(classifyCurlExit(60), "tls");
  assert.equal(classifyCurlExit(99), "other");
  assert.deepEqual(
    parseCurlMetadata("200\ntext/html; private=do-not-retain\n0.125\n"),
    {
      http_status: 200,
      content_type: "html",
      attempt_duration_ms: 125,
    },
  );
});

test("retained diagnostics contain only the fixed schema", () => {
  const root = mkdtempSync(join(tmpdir(), "gsv-e2e-http-diagnostic-"));
  const output = join(root, "readiness.ndjson");
  try {
    const diagnostic = buildHealthDiagnostic({
      endpoint: "gateway-health",
      attempts: 12,
      elapsedSeconds: 15,
      curlExitCode: 0,
      curlMetadata: "200\ntext/html; secret=header-value\n0.125\n",
      body: "<html>private body material</html>",
      bodyBytes: 34,
      expectedMarker: '"status":"healthy"',
    });
    diagnostic.unmodeled_private_field = "must not survive";
    recordHealthDiagnostic(output, diagnostic);

    const encoded = readFileSync(output, "utf8");
    const retained = JSON.parse(encoded);
    assert.equal(retained.endpoint, "gateway-health");
    assert.equal(retained.http_status, 200);
    assert.equal(retained.content_type, "html");
    assert.equal(retained.response_class, "non-json");
    assert.equal(retained.body_bytes, 34);
    assert.equal(Object.hasOwn(retained, "unmodeled_private_field"), false);
    assert.doesNotMatch(encoded, /private|secret|header-value|body material/);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
