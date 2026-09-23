import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstallationInvitesAdminHttp } from "./invites";
import { InstallationCreationInvites } from "../creation-invites";
import { InstallationOnboardingStore } from "../onboarding";
import { AccountStore } from "../store";

const ORIGIN = "https://accounts.example.com";
const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
const invites = new InstallationCreationInvites(env.INSTALLATIONS_DB, accounts, new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts));

describe("operator creation invites", () => {
  it("requires operator access, mutation origin and an available private policy", async () => {
    let allowed = false;
    const api = new InstallationInvitesAdminHttp(invites, { allows: async () => allowed }, ORIGIN,
      { choices: async () => [{ id: "early-access", name: "Early access" }] });
    const request = (body: unknown, origin = ORIGIN) => api.handle(new Request(`${ORIGIN}/admin/api/invites`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await request({}))?.status).toBe(403);
    allowed = true;
    expect((await request({ policyRef: "early-access" }, "https://attacker.example"))?.status).toBe(403);
    expect((await request({ policyRef: "arbitrary" }))?.status).toBe(400);
    const response = await request({ note: "early testers", policyRef: "early-access" });
    expect(response?.status).toBe(201);
    const issued = await response!.json<{ code: string; invite: { id: string } }>();
    const listing = await api.handle(new Request(`${ORIGIN}/admin/api/invites`));
    expect(await listing?.text()).not.toContain(issued.code);
    expect((await api.handle(new Request(`${ORIGIN}/admin/api/invites/${issued.invite.id}/revoke`, {
      method: "POST", headers: { origin: ORIGIN },
    })))?.status).toBe(200);
    expect((await invites.list()).find((invite) => invite.id === issued.invite.id)?.state).toBe("revoked");
  });
});
