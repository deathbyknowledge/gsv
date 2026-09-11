import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { InstallationOwnerStore } from "./owner-store";
import { OwnerIdentityProvider } from "./owner-identity";
import { InstallationOwnerHttp } from "./owner-http";
import { InstallationOwnerLinkService } from "./owner-service";
import { sha256Hex } from "./tokens";

const ORIGIN = "https://accounts.example.com";
async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const registry = `principal_registry_http_${suffix}`;
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  await accounts.createPrincipal({ principalId: registry, email: `${suffix}@registry.invalid`, displayName: "Registry", verified: true });
  const space = await accounts.reserveInstallation({ principalId: registry, operationId: `operation_http_${suffix}`, handle: `owner-${suffix}` });
  await env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(space.installationId).run();
  const store = new InstallationOwnerStore(env.INSTALLATIONS_DB, registry);
  const identity = new OwnerIdentityProvider({ issuer: "https://identity.example.com", clientId: "client", origin: ORIGIN });
  const begin = vi.spyOn(identity, "authorizationUrl").mockImplementation(async (attempt) => `https://identity.example.com/authorize?state=${attempt.id}`);
  const complete = vi.spyOn(identity, "complete").mockResolvedValue({ issuer: "https://identity.example.com", subject: suffix, email: `${suffix}@example.com`, name: "Owner" });
  const gateway = { authorizeRootRecovery: vi.fn(async () => ({ authorized: true as const })), confirmOwnerLinkAuthorization: vi.fn(async () => ({ authorized: true as const })) };
  const http = new InstallationOwnerHttp(store, identity, gateway, ORIGIN);
  const id = crypto.randomUUID();
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const service = new InstallationOwnerLinkService(store, ORIGIN, { authority: "kernel-owner-link" }, true);
  await service.beginInstallationOwnerLink({ installationId: space.installationId, attemptId: id, secretHash: await sha256Hex(secret) });
  const post = (path: string, values: Record<string, string>, origin = ORIGIN) => http.handle(new Request(`${ORIGIN}${path}`, {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values),
  }));
  const callback = (attemptId: string, cookie: string) => http.handle(new Request(`${ORIGIN}/owner/callback?state=${attemptId}&code=provider-code`, { headers: { cookie } }));
  return { http, store, gateway, registry, space, begin, complete, id, secret, post, callback };
}

describe("owner identity front door", () => {
  it("binds both proofs, links only the attested space, then authorizes owner recovery without choosing a local uid", async () => {
    const f = await fixture();
    const start = (await f.post("/owner/link", { id: f.id, secret: f.secret }))!;
    expect(start.status).toBe(303);
    expect(start.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(start.headers.get("cache-control")).toBe("no-store");
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    expect((await f.callback(f.id, ""))?.status).toBe(400);
    expect(f.complete).not.toHaveBeenCalled();
    const linked = (await f.callback(f.id, cookie))!;
    expect(linked.status).toBe(303);
    expect(f.gateway.confirmOwnerLinkAuthorization).toHaveBeenCalledWith({ installationId: f.space.installationId, attemptId: f.id });
    expect(linked.headers.get("location")).toBe(`${f.space.canonicalOrigin}/?owner=linked`);
    expect((await f.callback(f.id, cookie))?.status).toBe(303);
    expect(f.complete).toHaveBeenCalledTimes(1);
    const recoveryStart = (await f.post("/owner/recover", { handle: f.space.handle }))!;
    const recoveryId = new URL(recoveryStart.headers.get("location")!).searchParams.get("state")!;
    const recoveryCookie = recoveryStart.headers.get("set-cookie")!.split(";")[0];
    const recovered = (await f.callback(recoveryId, recoveryCookie))!;
    expect(recovered.status).toBe(303);
    const recoveryUrl = new URL(recovered.headers.get("location")!);
    expect(recoveryUrl.origin).toBe(f.space.canonicalOrigin);
    expect(recoveryUrl.pathname).toBe("/recover");
    const fragment = new URLSearchParams(recoveryUrl.hash.slice(1));
    expect(f.gateway.authorizeRootRecovery).toHaveBeenCalledWith({ installationId: f.space.installationId, attemptId: recoveryId,
      purpose: "root-password-reset", secretHash: await sha256Hex(fragment.get("secret")!), expiresAt: expect.any(Number) });
  });

  it("denies forged origins, wrong binding authority and root proof revoked during owner verification", async () => {
    const f = await fixture();
    expect(() => new InstallationOwnerLinkService(f.store, ORIGIN, undefined, true)).toThrow("authority");
    expect(() => new InstallationOwnerLinkService(f.store, ORIGIN, { authority: "kernel-owner-link" }, false)).toThrow("authority");
    expect((await f.post("/owner/link", { id: f.id, secret: f.secret }, "https://attacker.example.com"))?.status).toBe(403);
    expect(f.begin).not.toHaveBeenCalled();
    const started = (await f.post("/owner/link", { id: f.id, secret: f.secret }))!;
    f.gateway.confirmOwnerLinkAuthorization.mockRejectedValueOnce(new Error("root revoked"));
    expect((await f.callback(f.id, started.headers.get("set-cookie")!.split(";")[0]))?.status).toBe(400);
    expect(await env.INSTALLATIONS_DB.prepare("SELECT owner_principal_id FROM installations WHERE id = ?").bind(f.space.installationId).first("owner_principal_id")).toBe(f.registry);
  });

  it("does not reflect provider error material into the public response", async () => {
    const f = await fixture();
    const started = (await f.post("/owner/link", { id: f.id, secret: f.secret }))!;
    f.complete.mockRejectedValueOnce(new Error("private-token-provider-response"));
    const response = (await f.callback(f.id, started.headers.get("set-cookie")!.split(";")[0]))!;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-token-provider-response");
    expect(f.gateway.confirmOwnerLinkAuthorization).not.toHaveBeenCalled();
  });
});
