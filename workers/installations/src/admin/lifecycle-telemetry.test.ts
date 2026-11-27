import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetryRecordSchema, type TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "../onboarding";
import { CloudflareInstallationAdminAccess } from "./access";
import { InstallationAdminHttp } from "./http";
import { ShipInsight } from "./insight";
import { InstallationAdminService } from "./service";

const origin = "http://localhost:8976";

afterEach(() => {
  vi.restoreAllMocks();
});

function stack(telemetry?: TelemetryEnvironment) {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const service = new InstallationAdminService(env.INSTALLATIONS_DB, accounts, onboarding,
    { id: "principal_lifecycle_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {}, undefined, telemetry);
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }),
    origin, {}, undefined, new ShipInsight(env.INSTALLATIONS_DB));
  return { service, onboarding, http };
}

function api(path: string, body: Record<string, string>): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function activeShip({ service, onboarding }: ReturnType<typeof stack>, handle: string): Promise<string> {
  const created = await service.create({ operationId: `operation_${crypto.randomUUID()}`, handle });
  const installationId = created.installation.installationId;
  const authorized = await onboarding.authorize({ installationId, token: new URL(created.onboarding.onboardingUrl).hash.slice(1) });
  if (!authorized.ok) throw new Error("Expected valid onboarding");
  await onboarding.complete({ installationId, claimId: authorized.claimId });
  return installationId;
}

/** The lifecycle records Accounts wrote for the tail consumer, as the installation and event name. */
function lifecycleRecords() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return () => log.mock.calls.flatMap(([value]) => {
    const record = telemetryRecordSchema.safeParse(value);
    return record.success && record.data.event.stream === "product" && record.data.event.name.startsWith("installation.")
      ? [{ installationId: record.data.installationId, component: record.data.component, event: record.data.event }] : [];
  });
}

const reported = (installationId: string, name: string) =>
  ({ installationId, component: "accounts", event: { stream: "product", name, properties: {} } });

describe("reporting what became of an activated Ship", () => {
  it("reports a suspension and a reactivation once each, and nothing for a repeated change", async () => {
    const ships = stack({ GSV_TELEMETRY_ENABLED: "1" });
    const installationId = await activeShip(ships, "lifecycle-suspended");
    const records = lifecycleRecords();

    await ships.service.setInstallationState(installationId, "restricted");
    await ships.service.setInstallationState(installationId, "restricted");
    await ships.service.setInstallationState(installationId, "active");
    await ships.service.setInstallationState(installationId, "active");

    expect(records()).toEqual([
      reported(installationId, "installation.restricted"),
      reported(installationId, "installation.unrestricted"),
    ]);
  });

  it("reports the Ship a reset replaces as retired", async () => {
    const ships = stack({ GSV_TELEMETRY_ENABLED: "1" });
    const installationId = await activeShip(ships, "lifecycle-reset");
    const records = lifecycleRecords();

    const reset = await ships.service.resetInstallation(installationId, { operationId: `operation_${crypto.randomUUID()}`, confirmHandle: "lifecycle-reset" });

    expect(reset.installation.installationId).not.toBe(installationId);
    expect(records()).toEqual([reported(installationId, "installation.retired")]);
  });

  it("reports nothing when the deployment has telemetry off", async () => {
    const ships = stack();
    const installationId = await activeShip(ships, "lifecycle-quiet");
    const records = lifecycleRecords();

    await ships.service.setInstallationState(installationId, "restricted");

    expect(records()).toEqual([]);
  });
});

describe("reporting Ships whose state changed before it was reported", () => {
  it("reports each suspended, retired and erased Ship's present state, and leaves active Ships out", async () => {
    const quiet = stack();
    const active = await activeShip(quiet, "lifecycle-kept");
    const suspended = await activeShip(quiet, "lifecycle-held");
    await quiet.service.setInstallationState(suspended, "restricted");
    const replaced = await activeShip(quiet, "lifecycle-replaced");
    await quiet.service.resetInstallation(replaced, { operationId: `operation_${crypto.randomUUID()}`, confirmHandle: "lifecycle-replaced" });
    const erased = `installation_${crypto.randomUUID()}`;
    await env.INSTALLATIONS_DB.prepare(
      "INSERT INTO installation_account_deletions (installation_id, operation_id, phase, updated_at) VALUES (?, ?, 'erased', 1)",
    ).bind(erased, `operation_${crypto.randomUUID()}`).run();

    const ships = stack({ GSV_TELEMETRY_ENABLED: "1" });
    const records = lifecycleRecords();
    const response = await ships.http.handle(api("/admin/api/installation-lifecycle-report", {}));

    expect(response?.status).toBe(200);
    const body = await response!.json<{ reported: number; next: string | null }>();
    const all = records();
    expect(body).toEqual({ reported: all.length, next: null });
    expect(all).toEqual(expect.arrayContaining([
      reported(suspended, "installation.restricted"),
      reported(replaced, "installation.retired"),
      reported(erased, "installation.retired"),
    ]));
    expect(all.some((record) => record.installationId === active)).toBe(false);
  });

  it("refuses when the deployment has telemetry off", async () => {
    const ships = stack();
    const response = await ships.http.handle(api("/admin/api/installation-lifecycle-report", {}));

    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({ error: "installation telemetry is not enabled" });
  });
});
