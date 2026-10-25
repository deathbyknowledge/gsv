import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { telemetryRecordSchema } from "../../../packages/gsv/src/telemetry.ts";

const INSTALLATION_HEADER = "x-gsv-installation-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A tail Worker receives ripgit's logs the way an operator's telemetry consumer does.
const TAIL = `
const messages = [];
export default {
  tail(events) {
    for (const event of events) for (const log of event.logs) messages.push(log.message);
  },
  fetch() { return Response.json(messages); },
};`;

function ripgit(bindings = {}) {
  return new Miniflare({
    workers: [
      {
        name: "ripgit",
        modules: true,
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
        scriptPath: "build/index.js",
        modulesRoot: "build",
        compatibilityDate: "2026-03-18",
        durableObjects: { REPOSITORY: { className: "Repository", useSQLite: true } },
        bindings,
        tails: ["tail"],
      },
      { name: "tail", modules: true, script: TAIL, compatibilityDate: "2026-03-18" },
    ],
    durableObjectsPersist: false,
  });
}

describe("ripgit failure diagnostics", () => {
  let reporting;
  let silent;

  beforeAll(() => {
    reporting = ripgit({ GSV_TELEMETRY_ENABLED: "1" });
    silent = ripgit();
  });

  afterAll(async () => {
    await Promise.all([reporting.dispose(), silent.dispose()]);
  });

  it("answers an unexpected repository failure with its kind, cause and a diagnostic ID", async () => {
    const response = await apply(reporting, "inst_failure", "{");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toMatchObject({ error: "InternalError", kind: "repository" });
    expect(body.diagnosticId).toMatch(UUID);
    expect(body.message).toContain("invalid apply request");
  });

  it("answers a failure before any repository the same way", async () => {
    const response = await reporting.dispatchFetch("http://ripgit/.gsv/installation/quiesce", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    // The runtime parses request bodies, so it reports a malformed one.
    expect(body).toMatchObject({ error: "InternalError", kind: "runtime" });
    expect(body.diagnosticId).toMatch(UUID);
  });

  it("reports each failure once, as a closed telemetry record without its cause", async () => {
    const { diagnosticId } = await (await apply(reporting, "inst_reported", "{")).json();

    const records = await telemetryFor(reporting, diagnosticId);
    expect(records).toHaveLength(1);
    expect(telemetryRecordSchema.parse(records[0])).toMatchObject({
      installationId: "inst_reported",
      component: "ripgit",
      event: {
        stream: "operational",
        name: "ripgit.request.failed",
        properties: { diagnosticId, outcome: "failed", route: "apply", kind: "repository" },
      },
    });
    expect(JSON.stringify(records[0])).not.toContain("invalid apply request");
  });

  it("answers a retired installation's late request with the index's own diagnostic", async () => {
    await create(reporting, "inst_retired", "home");
    const retirement = { version: 1, installationId: "inst_retired", operationId: "delete-inst-retired" };
    for (const action of ["quiesce", "erase"]) {
      const response = await reporting.dispatchFetch(`http://ripgit/.gsv/installation/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(retirement),
      });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }

    const late = await reporting.dispatchFetch("http://ripgit/hyperspace/repos/alice/late/refs", {
      headers: { [INSTALLATION_HEADER]: "inst_retired" },
    });

    expect(late.status).toBe(500);
    const body = await late.json();
    expect(body).toMatchObject({ error: "InternalError", kind: "repository", message: "Installation is retired" });
    const records = await telemetryFor(reporting, body.diagnosticId);
    expect(records.map((record) => record.event.properties.route)).toEqual(["registration"]);
  });

  it("records nothing unless the deployment enables telemetry", async () => {
    const { diagnosticId } = await (await apply(silent, "inst_silent", "{")).json();

    // The logged cause names the diagnostic, so its arrival proves the tail saw this failure.
    await waitFor(silent, (messages) => messages.some((message) => String(message[0]).includes(diagnosticId)));
    expect(telemetryRecords(await tailMessages(silent))).toEqual([]);
  });
});

function apply(miniflare, installationId, body) {
  return miniflare.dispatchFetch("http://ripgit/hyperspace/repos/alice/home/apply", {
    method: "POST", headers: { [INSTALLATION_HEADER]: installationId, "content-type": "application/json" }, body,
  });
}

async function create(miniflare, installationId, repo) {
  const response = await miniflare.dispatchFetch(`http://ripgit/hyperspace/repos/alice/${repo}/apply`, {
    method: "POST",
    headers: { [INSTALLATION_HEADER]: installationId, "content-type": "application/json" },
    body: JSON.stringify({
      defaultBranch: "main", author: "alice", email: "alice@example.invalid", message: "fixture commit",
      ops: [{ type: "put", path: "page.txt", contentBytes: [104, 105] }],
    }),
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
}

async function tailMessages(miniflare) {
  const tail = await miniflare.getWorker("tail");
  return (await tail.fetch("http://tail/")).json();
}

function telemetryRecords(messages) {
  return messages
    .filter((message) => message.length === 1 && message[0]?.marker === "gsv.telemetry")
    .map((message) => message[0]);
}

async function waitFor(miniflare, done) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const messages = await tailMessages(miniflare);
    if (done(messages)) return messages;
    if (Date.now() > deadline) throw new Error("The tail Worker never received the expected logs");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function telemetryFor(miniflare, diagnosticId) {
  const ofFailure = (messages) => telemetryRecords(messages)
    .filter((record) => record.event?.properties?.diagnosticId === diagnosticId);
  await waitFor(miniflare, (messages) => ofFailure(messages).length > 0);
  // Give a duplicate record from another boundary time to arrive before counting.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return ofFailure(await tailMessages(miniflare));
}
