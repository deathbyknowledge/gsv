import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallationInvitesAdminHttp } from "./invites";
import { InstallationCreationInvites } from "../creation-invites";
import { InstallationOnboardingStore } from "../onboarding";
import { AccountStore } from "../store";

const ORIGIN = "https://accounts.example.com";
const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
const invites = new InstallationCreationInvites(env.INSTALLATIONS_DB, accounts, new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts));

afterEach(() => vi.restoreAllMocks());

describe("operator creation invites", () => {
  it("displays the new code without reading page data again after creation", async () => {
    const choices = vi.fn(async () => [{ id: "early-access", name: "Early access" }]);
    const list = vi.spyOn(invites, "list");
    const create = invites.create.bind(invites);
    vi.spyOn(invites, "create").mockImplementation(async (input) => {
      const issued = await create(input);
      choices.mockRejectedValue(new Error("Plan lookup unavailable"));
      list.mockRejectedValue(new Error("Invite listing unavailable"));
      return issued;
    });
    const page = new InstallationInvitesAdminHttp(invites, { allows: async () => true }, ORIGIN, { choices });
    const response = await page.handle(new Request(`${ORIGIN}/admin/invites`, {
      method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams({ policyRef: "early-access", note: "new cohort" }),
    }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toContain("no-store");
    const html = await response!.text();
    const code = html.match(/<textarea[^>]*>(invite_[A-Za-z0-9_-]{43})<\/textarea>/)?.[1];
    expect(code).toBeTruthy();
    expect(html).toContain("new cohort");
    expect(html).toContain('<option value="early-access">Early access</option>');
    expect(choices).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    const principal = await accounts.createPrincipal({ email: "issued-invite@example.com", displayName: "Owner", verified: true });
    expect((await invites.claim(code!, principal.id)).state).toBe("claimed");
    list.mockRestore();
    choices.mockResolvedValue([{ id: "another-plan", name: "Another plan" }]);
    const refreshed = await page.handle(new Request(`${ORIGIN}/admin/invites`));
    expect(refreshed?.status).toBe(200);
    const refreshedHtml = await refreshed!.text();
    expect(refreshedHtml).toContain('<option value="another-plan">Another plan</option>');
    expect(refreshedHtml).not.toContain(code);
  });

  it.each(["plans", "invites"])("does not issue a code if the %s needed to render the page are unavailable", async (unavailable) => {
    const choices = vi.fn(async () => [{ id: "early-access", name: "Early access" }]);
    const list = vi.spyOn(invites, "list");
    const create = vi.spyOn(invites, "create");
    if (unavailable === "plans") choices.mockRejectedValue(new Error("Unavailable"));
    else list.mockRejectedValue(new Error("Unavailable"));
    const page = new InstallationInvitesAdminHttp(invites, { allows: async () => true }, ORIGIN, { choices });
    const response = await page.handle(new Request(`${ORIGIN}/admin/invites`, {
      method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams({ policyRef: "early-access" }),
    }));
    expect(response?.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires operator access, mutation origin and an available private policy", async () => {
    let allowed = false;
    const api = new InstallationInvitesAdminHttp(invites, { allows: async () => allowed }, ORIGIN,
      { choices: async () => [{ id: "early-access", name: "Early access" }] });
    const request = (body: Parameters<InstallationCreationInvites["create"]>[0], origin = ORIGIN) => api.handle(new Request(`${ORIGIN}/admin/api/invites`, {
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
