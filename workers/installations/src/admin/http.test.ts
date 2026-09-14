import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "../onboarding";
import { CloudflareInstallationAdminAccess } from "./access";
import { InstallationAdminHttp } from "./http";
import { InstallationAdminService } from "./service";

const origin = "http://localhost:8976";

function stack() {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const service = new InstallationAdminService(env.INSTALLATIONS_DB, accounts, onboarding,
    { id: "principal_html_operator", email: "operator@example.com", displayName: "Operator" }, {});
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }), origin);
  return { accounts, onboarding, service, http };
}

function form(path: string, values: Record<string, string>, requestOrigin: string | null = origin): Request {
  return new Request(`${origin}${path}`, {
    method: "POST", headers: requestOrigin === null ? {} : { origin: requestOrigin }, body: new URLSearchParams(values),
  });
}

async function html(response: Response | null, status = 200): Promise<string> {
  expect(response?.status).toBe(status);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("referrer-policy")).toBe("same-origin");
  expect(response?.headers.get("content-security-policy")).toContain("form-action 'self'");
  const body = await response!.text();
  for (const privateContent of ["Inference", "inference", "Monthly USD", "Allowance", "Spend", "Pricing"]) {
    expect(body).not.toContain(privateContent);
  }
  return body;
}

function claim(body: string): URL {
  const value = body.match(/href="([^"]+\/onboarding#[^"]+)"/);
  if (!value) throw new Error("Expected a one-time onboarding link");
  return new URL(value[1]);
}

it("runs fresh installation administration through the public screens without commercial data", async () => {
  const { accounts, onboarding, service, http } = stack();
  const newPage = await html(await http.handle(new Request(`${origin}/admin/installations/new`)));
  const operationId = newPage.match(/name="operationId" value="([^"]+)"/)?.[1];
  expect(operationId).toBeTruthy();
  const created = await html(await http.handle(form("/admin/installations", { operationId: operationId!, handle: "owner" })), 201);
  const firstClaim = claim(created);
  const list = await service.listInstallations({ query: "owner", state: null, page: 1 });
  const installationId = list.installations[0].installationId;
  const path = `/admin/installations/${installationId}`;
  const detail = await html(await http.handle(new Request(`${origin}${path}`)));
  expect(detail).toContain("Reissue onboarding link");
  expect(detail).not.toContain(firstClaim.hash.slice(1));
  const reissued = claim(await html(await http.handle(form(`${path}/onboarding`, {}))));
  await expect(onboarding.authorize({ installationId, token: firstClaim.hash.slice(1) })).resolves.toMatchObject({ ok: false });
  const authorized = await onboarding.authorize({ installationId, token: reissued.hash.slice(1) });
  if (!authorized.ok) throw new Error("Expected valid onboarding");
  await onboarding.complete({ installationId, claimId: authorized.claimId });
  expect(await html(await http.handle(new Request(`${origin}${path}`)))).toContain("Suspend owner");
  const suspended = await http.handle(form(`${path}/lifecycle`, { state: "restricted" }));
  expect(suspended?.status).toBe(303);
  expect(suspended?.headers.get("location")).toBe(path);
  expect(suspended?.headers.get("cache-control")).toBe("no-store");
  expect(await html(await http.handle(new Request(`${origin}${path}`)))).toContain("Reactivate owner");
  expect((await http.handle(form(`${path}/lifecycle`, { state: "active" })))?.status).toBe(303);
  const reset = await html(await http.handle(form(`${path}/reset`, { operationId: "reset_html_owner", confirmHandle: "owner" })), 201);
  expect(reset).toContain("pending deletion");
  expect(reset).toContain("reset itself did not erase it");
  expect(claim(reset).hash).not.toBe(reissued.hash);
  await expect(accounts.resolveInstallation(installationId)).resolves.toMatchObject({ state: "retained" });
  const replacement = (await service.listInstallations({ query: "owner", state: null, page: 1 })).installations[0];
  expect(replacement.installationId).not.toBe(installationId);
  const registry = await html(await http.handle(new Request(`${origin}/admin?state=provisioning`)));
  expect(registry).toContain(replacement.installationId);
  expect(registry).not.toContain("onboard_");
  const api = await http.handle(new Request(`${origin}/admin/api/installations/${replacement.installationId}`));
  expect(api?.headers.get("referrer-policy")).toBe("no-referrer");
  await expect(api?.json()).resolves.toMatchObject({ installationId: replacement.installationId, state: "provisioning" });
  expect((await env.INSTALLATIONS_DB.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'managed_inference_%'").all()).results).toEqual([]);
});

it("admits neither reads nor mutations before authentication and exact-origin validation", async () => {
  const { service, http } = stack();
  const before = await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS total FROM installations").first();
  const list = vi.spyOn(service, "listInstallations");
  const create = vi.spyOn(service, "create");
  const denied = new InstallationAdminHttp(service, { allows: async () => false }, origin);
  for (const path of ["/admin", "/admin/installations/new", "/admin/styles.css", "/admin/api/installations"]) {
    expect((await denied.handle(new Request(`${origin}${path}`)))?.status).toBe(403);
  }
  expect(list).not.toHaveBeenCalled();
  for (const suppliedOrigin of [null, "https://attacker.example", `${origin}/path`]) {
    for (const path of ["/admin/installations", "/admin/installations/inst_one/onboarding", "/admin/installations/inst_one/reset", "/admin/installations/inst_one/lifecycle"]) {
      expect((await http.handle(form(path, { operationId: "denied", handle: "denied" }, suppliedOrigin)))?.status).toBe(403);
    }
  }
  expect(create).not.toHaveBeenCalled();
  expect(await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS total FROM installations").first()).toEqual(before);
});

it("preserves escaped retry input, conceals unexpected errors, and serves safe HEAD and stylesheet responses", async () => {
  const { service, http } = stack();
  const create = vi.spyOn(service, "create").mockRejectedValue(new Error("handle <script> is unavailable"));
  const failed = await html(await http.handle(form("/admin/installations", { operationId: "operation_retry", handle: '"><script>bad</script>' })), 400);
  expect(failed).toContain('value="operation_retry"');
  expect(failed).toContain("&quot;&gt;&lt;script&gt;bad&lt;/script&gt;");
  expect(failed).not.toContain("<script>");
  create.mockRejectedValue(new Error("upstream secret detail"));
  const unavailable = await html(await http.handle(form("/admin/installations", { operationId: "operation_retry", handle: "owner" })), 503);
  expect(unavailable).not.toContain("upstream secret detail");
  expect(unavailable).toContain("could not be completed");
  for (const path of ["/admin", "/admin/installations/new", "/admin/styles.css"]) {
    const response = await http.handle(new Request(`${origin}${path}`, { method: "HEAD" }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.text()).toBe("");
  }
  const stylesheet = await http.handle(new Request(`${origin}/admin/styles.css`));
  expect(stylesheet?.headers.get("content-type")).toContain("text/css");
  expect(await stylesheet?.text()).toContain(".topbar");
  await html(await http.handle(new Request(`${origin}/admin/inference`)), 404);
  expect(await http.handle(new Request(`${origin}/other`))).toBeNull();
});

it("rejects invalid and oversized forms and queries before invoking services", async () => {
  const { service, http } = stack();
  const list = vi.spyOn(service, "listInstallations");
  for (const query of ["?page=0", "?state=unknown", `?q=${"x".repeat(101)}`]) {
    await html(await http.handle(new Request(`${origin}/admin${query}`)), 400);
  }
  expect(list).not.toHaveBeenCalled();
  const create = vi.spyOn(service, "create");
  await html(await http.handle(new Request(`${origin}/admin/installations`, { method: "POST", headers: { origin }, body: "invalid form" })), 400);
  await html(await http.handle(form("/admin/installations", { operationId: "oversized", handle: "x".repeat(16 * 1024) })), 400);
  const cancelled = vi.fn();
  await html(await http.handle(new Request(`${origin}/admin/installations`, {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)); }, cancel: cancelled,
    }),
  })), 400);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
});
