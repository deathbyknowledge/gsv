// Renders the operator pages with invented sample data for a local preview.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adminAuditPage } from "../src/admin/audit-page";
import { adminInstallationPage, adminInstallationsPage, adminNewInstallationPage } from "../src/admin/installations-page";
import { adminStylesheet } from "../src/admin/page";
import type { OperatorAuditEvent, ShipView } from "../src/admin/insight";
import type { AdminInstallation } from "../src/administration";

const out = process.argv[2];
if (!out) throw new Error("usage: render-admin-preview.ts <output dir>");

const now = Date.UTC(2026, 9, 22, 12, 0, 0);
const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 22, h, m, s);

const ship: AdminInstallation = {
  installationId: "inst_7d1c2a90-demo-4e3b-9a51-preview0001",
  handle: "ada",
  canonicalOrigin: "https://ada.ship.space",
  state: "active",
  operationState: "completed",
  onboardingExpiresAt: null,
  createdAt: Date.UTC(2026, 9, 19, 19, 20),
  activatedAt: Date.UTC(2026, 9, 19, 19, 21),
  reset: null,
};

const audit: OperatorAuditEvent[] = [
  { id: "a3", at: at(11, 52), actor: "operator@example.com", action: "plan.assign", installationId: ship.installationId, handle: "ada", detail: { plan: "early-access" }, reason: null, outcome: "completed" },
  { id: "a2", at: Date.UTC(2026, 9, 21, 9, 4), actor: "operator@example.com", action: "ship.reactivate", installationId: ship.installationId, handle: "ada", detail: null, reason: "Payment sorted", outcome: "completed" },
  { id: "a1", at: Date.UTC(2026, 9, 20, 17, 40), actor: "operator credential", action: "ship.suspend", installationId: ship.installationId, handle: "ada", detail: null, reason: "Abuse report under review", outcome: "completed" },
];

const view: ShipView = {
  context: {
    owner: { email: "ada@example.com", operatorIssued: false, signIn: ["email", "accounts.google.com"] },
    mailAddress: "ada@ship.space",
    hostnames: [
      { hostname: "ada.ship.space", kind: "canonical", state: "active" },
      { hostname: "ada.gsv.space", kind: "alias", state: "active" },
    ],
    audit,
  },
  health: {
    kind: "ok",
    snapshot: {
      version: 1,
      installationId: ship.installationId,
      capturedAt: now,
      ship: {
        pid: "proc:0c05-demo", state: "idle", lastActiveAt: at(11, 43, 20), activeRunId: null,
        queuedCount: 0, pendingApprovals: 0, lastCompactionAt: at(10, 1, 2),
      },
      processes: { total: 12, running: 0 },
      messengers: [{ adapter: "whatsapp", linkedAt: Date.UTC(2026, 9, 19, 19, 40) }],
      targets: [
        { id: "gsv", online: true, lastSeenAt: now },
        { id: "Device 1", online: true, lastSeenAt: at(11, 59) },
        { id: "Device 2", online: false, lastSeenAt: Date.UTC(2026, 9, 20, 18, 2) },
      ],
      shipEvents: { queued: 0, oldestQueuedAt: null },
      openResponsibilities: 3,
      runs: [
        {
          runId: "adapter-run:b56c", origin: "adapter", inputChars: 47, inputHasMedia: false,
          startedAt: at(11, 43, 10), durationMs: 10_400, status: "ok",
          steps: [
            { kind: "inference", name: "gsv · default", startedAt: at(11, 43, 11), durationMs: 8_900, status: "ok" },
            { kind: "tool", name: "Send", target: "gsv", startedAt: at(11, 43, 20), durationMs: 200, status: "ok" },
            { kind: "delivery", name: "Send message", startedAt: at(11, 43, 20), durationMs: 200, status: "ok" },
          ],
        },
        {
          runId: "adapter-run:8a28", origin: "adapter", inputChars: 7, inputHasMedia: true,
          startedAt: at(11, 41, 16), durationMs: 44_000, status: "ok",
          steps: [
            { kind: "inference", name: "gsv · default", startedAt: at(11, 41, 18), durationMs: 41_600, status: "ok" },
            { kind: "tool", name: "Send", target: "gsv", startedAt: at(11, 42, 0), durationMs: 300, status: "ok" },
          ],
        },
        {
          runId: "adapter-run:8325", origin: "adapter", inputChars: 10_450, inputHasMedia: false,
          startedAt: at(11, 29, 57), durationMs: 438_800, status: "ok",
          steps: [
            { kind: "inference", name: "gsv · default", startedAt: at(11, 30, 1), durationMs: 5_400, status: "ok" },
            { kind: "tool", name: "Shell", target: "gsv", startedAt: at(11, 30, 6), durationMs: 3_000, status: "error" },
            { kind: "inference", name: "gsv · default", startedAt: at(11, 30, 11), durationMs: 1_400, status: "ok" },
            { kind: "tool", name: "Shell", target: "gsv", startedAt: at(11, 30, 13), durationMs: 4_800, status: "ok" },
            { kind: "inference", name: "gsv · default", startedAt: at(11, 30, 19), durationMs: 9_100, status: "ok" },
            { kind: "tool", name: "Shell", target: "Device 1", startedAt: at(11, 30, 28), durationMs: 375_100, status: "ok" },
            { kind: "inference", name: "gsv · default", startedAt: at(11, 36, 45), durationMs: 10_300, status: "ok" },
            { kind: "tool", name: "Shell", target: "Device 1", startedAt: at(11, 36, 56), durationMs: 800, status: "ok" },
            { kind: "inference", name: "gsv · default", startedAt: at(11, 36, 58), durationMs: 17_000, status: "ok" },
            { kind: "tool", name: "Send", target: "gsv", startedAt: at(11, 37, 15), durationMs: 200, status: "ok" },
            { kind: "delivery", name: "Send message", startedAt: at(11, 37, 15), durationMs: 200, status: "ok" },
          ],
        },
        {
          runId: "adapter-run:f8f6", origin: "adapter", inputChars: 89, inputHasMedia: false,
          startedAt: at(11, 29, 51), durationMs: 6_000, status: "aborted",
          steps: [
            { kind: "inference", name: "gsv · default", startedAt: at(11, 29, 52), durationMs: 3_900, status: "ok" },
            { kind: "tool", name: "Shell", target: "gsv", startedAt: at(11, 29, 56), durationMs: 1_000, status: "cancelled" },
          ],
        },
        {
          runId: "run:msg:cae3", origin: "client", inputChars: 67, inputHasMedia: false,
          startedAt: at(10, 7, 13), durationMs: 36_000, status: "ok",
          steps: [
            { kind: "inference", name: "gsv · default", startedAt: at(10, 7, 14), durationMs: 26_000, status: "ok" },
            { kind: "tool", name: "Shell", target: "gsv", startedAt: at(10, 7, 40), durationMs: 2_000, status: "ok" },
            { kind: "tool", name: "Send", target: "gsv", startedAt: at(10, 7, 49), durationMs: 300, status: "ok" },
          ],
        },
        {
          runId: "schedule:morning-brief", origin: "schedule", inputChars: 182, inputHasMedia: false,
          startedAt: at(6, 58, 30), durationMs: 92_000, status: "error",
          steps: [
            { kind: "inference", name: "gsv · default", startedAt: at(6, 58, 31), durationMs: 12_000, status: "ok" },
            { kind: "tool", name: "Search", target: "gsv", startedAt: at(6, 58, 44), durationMs: 70_000, status: "error" },
          ],
        },
      ],
    },
  },
};

const unavailable: ShipView = { context: view.context, health: { kind: "unavailable", reason: "not connected" } };

const list = {
  query: "", state: null, page: 1, pageSize: 25, total: 4, totalPages: 1,
  installations: [
    { installationId: ship.installationId, handle: "ada", state: "active" as const, operationState: "completed" as const, createdAt: ship.createdAt },
    { installationId: "inst_demo-0002", handle: "grace", state: "active" as const, operationState: "completed" as const, createdAt: Date.UTC(2026, 9, 12) },
    { installationId: "inst_demo-0003", handle: "linus", state: "restricted" as const, operationState: "completed" as const, createdAt: Date.UTC(2026, 8, 30) },
    { installationId: "inst_demo-0004", handle: "margaret", state: "provisioning" as const, operationState: "pending" as const, createdAt: Date.UTC(2026, 9, 22, 9) },
  ],
};

async function save(path: string, response: Response): Promise<void> {
  const file = join(out!, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await response.text());
}

await save("admin/styles.css", adminStylesheet(false));
await save("admin/installations/index.html", adminInstallationsPage(list));
await save("admin/installations/new/index.html", adminNewInstallationPage());
await save(`admin/installations/${ship.installationId}/index.html`, adminInstallationPage(ship, undefined, undefined, false, 200, {}, view));
await save("admin/installations/inst_demo-0002/index.html", adminInstallationPage(
  { ...ship, installationId: "inst_demo-0002", handle: "grace", canonicalOrigin: "https://grace.ship.space" },
  undefined, undefined, false, 200, {}, { ...unavailable, context: { ...unavailable.context, mailAddress: "grace@ship.space", audit: [] } },
));
await save("admin/audit/index.html", adminAuditPage({ events: audit, page: 1, totalPages: 1 }));
await save("index.html", new Response(`<!doctype html><meta http-equiv="refresh" content="0; url=/admin/installations/${ship.installationId}/">`));
console.log("rendered");
