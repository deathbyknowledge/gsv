import { env, exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "../onboarding";
import type { JsonObject } from "../http";
import { InstallationAdminApi } from "./api";
import { CloudflareInstallationAdminAccess } from "./access";
import { InstallationAdminService, type IssuedAdminInstallation } from "./service";

const origin = "http://localhost:8976";
const registry = { id: "principal_test_operator", email: "operator@example.com", displayName: "Operator" };

function stack() {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const service = new InstallationAdminService(env.INSTALLATIONS_DB, accounts,
    new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts), registry, {});
  const api = new InstallationAdminApi(service,
    new CloudflareInstallationAdminAccess({ environment: "development", origin }), origin);
  return { accounts, service, api };
}

function request(path = "", body?: JsonObject, requestOrigin: string | null = origin): Request {
  const url = `${origin}/admin/api/installations${path}`;
  if (body === undefined) return new Request(url);
  const headers = new Headers({ "content-type": "application/json" });
  if (requestOrigin !== null) headers.set("origin", requestOrigin);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function issue(api: InstallationAdminApi, path: string, body: JsonObject): Promise<IssuedAdminInstallation> {
  const response = await api.handle(request(path, body));
  expect(response?.status).toBe(path.endsWith("onboarding") ? 200 : 201);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  if (!response) throw new Error("Expected an installation response");
  return response.json<IssuedAdminInstallation>();
}

async function finishSetup(issued: IssuedAdminInstallation) {
  const authorization = await exports.default.authorizeInstallationOnboarding({
    installationId: issued.installation.installationId,
    token: new URL(issued.onboarding.onboardingUrl).hash.slice(1),
  });
  if (!authorization.ok) throw new Error("Setup was not authorized");
  await exports.default.completeInstallationOnboarding({
    claimId: authorization.claimId, installationId: issued.installation.installationId,
  });
}

it("runs fresh operator administration, setup and reset without commercial services", async () => {
  const { api, accounts } = stack();
  const first = await issue(api, "", { operationId: "create_one", handle: "one", principalId: "principal_attacker" });
  const second = await issue(api, "", { operationId: "create_two", handle: "two" });
  expect(first.installation).not.toHaveProperty("inference");
  const owners = await env.INSTALLATIONS_DB.prepare("SELECT owner_principal_id FROM installations").all();
  expect(owners.results).toEqual([{ owner_principal_id: registry.id }, { owner_principal_id: registry.id }]);
  const reissued = await issue(api, `/${first.installation.installationId}/onboarding`, {});
  await expect(exports.default.authorizeInstallationOnboarding({
    installationId: first.installation.installationId, token: new URL(first.onboarding.onboardingUrl).hash.slice(1),
  })).resolves.toMatchObject({ ok: false });
  await finishSetup(reissued);
  await finishSetup(second);
  const firstPath = `/${first.installation.installationId}`;
  expect((await api.handle(request(`${firstPath}/lifecycle`, { state: "restricted" })))?.status).toBe(200);
  await expect(accounts.resolveHostname("one.example.com")).resolves.toMatchObject({ state: "restricted" });
  expect((await api.handle(request(`${firstPath}/lifecycle`, { state: "active" })))?.status).toBe(200);
  const replacement = await issue(api, `${firstPath}/reset`, { operationId: "reset_one", confirmHandle: "one" });
  expect(replacement.installation.installationId).not.toBe(first.installation.installationId);
  expect(replacement.reset).toEqual({ previousInstallationId: first.installation.installationId, dataDeletionState: "pending" });
  await finishSetup(replacement);
  await expect(accounts.resolveInstallation(first.installation.installationId)).resolves.toMatchObject({ state: "retained" });
  await expect(accounts.resolveHostname("two.example.com")).resolves.toMatchObject({ installationId: second.installation.installationId, state: "active" });
  const list = await api.handle(request("?state=active"));
  await expect(list?.json()).resolves.toMatchObject({ total: 2 });
  const detail = await api.handle(request(`/${replacement.installation.installationId}`));
  await expect(detail?.json()).resolves.toMatchObject({ state: "active", handle: "one" });
  expect((await env.INSTALLATIONS_DB.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'managed_inference_%'").all()).results).toEqual([]);
});

it("refuses unconfigured public access and cross-origin mutations before creating state", async () => {
  const { api } = stack();
  const before = await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS count FROM principals").first();
  const blocked = await exports.default.fetch(new Request("https://accounts.example.com/admin/api/installations"));
  expect(blocked.status).toBe(403);
  for (const suppliedOrigin of [null, "https://attacker.example", `${origin}/path`]) {
    expect((await api.handle(request("", { operationId: "denied", handle: "denied" }, suppliedOrigin)))?.status).toBe(403);
  }
  expect((await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS count FROM principals").first())).toEqual(before);
  const { service } = stack();
  const create = vi.spyOn(service, "create");
  const denied = new InstallationAdminApi(service, { allows: async () => false }, origin);
  expect((await denied.handle(request("", { operationId: "denied", handle: "denied" })))?.status).toBe(403);
  expect(create).not.toHaveBeenCalled();
});

it("validates queries and bounds chunked JSON before invoking administrative operations", async () => {
  const { api, service } = stack();
  const list = vi.spyOn(service, "listInstallations");
  for (const query of ["?page=0", "?page=1000001", "?state=unknown", `?q=${"x".repeat(101)}`]) {
    expect((await api.handle(request(query)))?.status).toBe(400);
  }
  expect(list).not.toHaveBeenCalled();
  const create = vi.spyOn(service, "create");
  const cancelled = vi.fn();
  const response = await api.handle(new Request(`${origin}/admin/api/installations`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)); }, cancel: cancelled,
    }),
  }));
  expect(response?.status).toBe(400);
  await expect(response?.json()).resolves.toEqual({ error: "request body is too large" });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(await api.handle(new Request(`${origin}/admin/api/inference`))).toBeNull();
  expect(await api.handle(new Request(`${origin}/admin/api/installations/one/inference`))).toBeNull();
});
