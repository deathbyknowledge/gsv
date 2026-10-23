import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { UsernamePolicy, normalizeUsernamePolicy, type UsernamePolicyLists } from "./username-policy";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationSignup } from "./signup";
import { InstallationAdminService } from "./admin/service";
import { InstallationAdminHttp } from "./admin/http";
import { ShipInsight } from "./admin/insight";

const db = env.INSTALLATIONS_DB;
const policy = new UsernamePolicy(db);
const accounts = new AccountStore(db, "example.com", undefined, ["mail.example.com"]);
const onboarding = new InstallationOnboardingStore(db, accounts, "blocked-handle-test-".repeat(4));
const signup = new InstallationSignup(db, accounts, onboarding, true);
const origin = "https://accounts.example.com";
let initial: UsernamePolicyLists;
beforeEach(async () => { initial = await policy.list(); });
afterEach(async () => { vi.restoreAllMocks(); await policy.replace({ reserved: initial.reserved.join("\n"), blocked: initial.blocked.join("\n") }); });

async function owner() {
  const id = crypto.randomUUID();
  await accounts.createPrincipal({ principalId: id, email: `${id}@example.com`, displayName: "Owner", verified: true });
  return id;
}

function admin(allows = true) {
  const service = new InstallationAdminService(db, accounts, onboarding,
    { id: "blocklist_operator", email: "operator@example.com", displayName: "Operator" }, {});
  const insight = new ShipInsight(db, {});
  return { service, insight, http: new InstallationAdminHttp(service, { allows: async () => allows }, origin, {}, undefined, insight) };
}

function save(blocked: string, requestOrigin: string | null = origin, reserved = "") {
  return new Request(`${origin}/admin/signup`, { method: "POST", headers: requestOrigin ? { origin: requestOrigin } : {},
    body: new URLSearchParams({ reserved, blocked }) });
}

it("edits signup policy through administration and completes a fresh signup after unblocking", async () => {
  const { http, insight } = admin();
  expect(initial.reserved).toEqual(expect.arrayContaining(["admin", "root", "support", "ship"]));
  expect(initial.blocked).toEqual(expect.arrayContaining(["hitler", "killyourself", "pedofilo"]));
  expect(await (await http.handle(new Request(`${origin}/admin/signup`)))!.text()).toContain("Username policy");
  expect((await http.handle(save(" Newsletter, NEWSLETTER\npress ")))?.status).toBe(303);
  expect(await policy.list()).toEqual({ reserved: [], blocked: ["Newsletter", "press"] });
  expect((await insight.audit.list({ page: 1 })).events[0]).toMatchObject({ action: "signup.username-policy.update", outcome: "completed" });
  const operationId = crypto.randomUUID(), principalId = await owner();
  expect(await signup.available("newsletter")).toBe(false);
  expect(await signup.available("newsletter-team")).toBe(true);
  await expect(signup.prepare(operationId, principalId, "newsletter")).rejects.toThrow("handle is unavailable");
  expect(await accounts.getReservationByOperation(operationId)).toBeNull();
  expect((await http.handle(save("")))?.status).toBe(303);
  expect(await signup.available("newsletter")).toBe(true);
  for (const name of ["signup", "docs", "mail"]) expect(await signup.available(name)).toBe(false);
  const prepared = await signup.prepare(operationId, principalId, "newsletter");
  const space = (await accounts.getReservationByOperation(operationId))!;
  await policy.replace({ reserved: "", blocked: "newsletter" });
  expect((await signup.prepare(operationId, principalId, "newsletter")).onboardingToken).toBe(prepared.onboardingToken);
  const authorization = await onboarding.authorize({ installationId: space.installationId, token: prepared.onboardingToken! });
  if (!authorization.ok) throw new Error("Expected setup authorization");
  await onboarding.complete({ installationId: space.installationId, claimId: authorization.claimId });
  expect(await accounts.resolveHostname("newsletter.example.com")).toMatchObject({ state: "active" });
  expect((await signup.prepare(operationId, principalId, "newsletter")).onboardingToken).toBeNull();
});

it("enforces a block committed after availability and immediately before reservation", async () => {
  const name = "newly-blocked";
  expect(await signup.available(name)).toBe(true);
  const principalId = await owner(), operationId = crypto.randomUUID();
  const batch = db.batch.bind(db);
  vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
    await db.prepare("INSERT INTO username_policy (kind, normalized_handle, entry) VALUES ('blocked', ?, ?)").bind(normalizeUsernamePolicy(name), name).run();
    return batch(statements);
  });
  await expect(accounts.reserveInstallation({ principalId, operationId, handle: name })).rejects.toThrow("handle is unavailable");
  expect(await accounts.getReservationByOperation(operationId)).toBeNull();
  expect(await accounts.resolveHostname(`${name}.example.com`)).toEqual({ found: false });
});

it("rejects unauthorized saves, preserves invalid input safely, and never partially replaces policy", async () => {
  const { http } = admin();
  const denied = admin(false).http;
  for (const request of [new Request(`${origin}/admin/signup`), save("bad")]) {
    expect((await denied.handle(request))?.status).toBe(403);
  }
  for (const requestOrigin of [null, "https://attacker.example"]) expect((await http.handle(save("bad", requestOrigin)))?.status).toBe(403);
  const invalid = await http.handle(save("valid\n</textarea><script>bad</script>"));
  expect(invalid?.status).toBe(400);
  const body = await invalid!.text();
  expect(body).toContain("&lt;/textarea&gt;&lt;script&gt;");
  expect(body).not.toContain("<script>bad");
  expect((await http.handle(save(Array.from({ length: 501 }, (_, i) => `name-${i}`).join("\n"))))?.status).toBe(400);
  expect(await policy.list()).toEqual(initial);
  const head = await http.handle(new Request(`${origin}/admin/signup`, { method: "HEAD" }));
  expect(head?.headers.get("cache-control")).toBe("no-store");
  expect(await head?.text()).toBe("");
});

it("normalizes policy entries and candidates without changing identity or blocking substrings", async () => {
  expect(normalizeUsernamePolicy(" Shíp_Suppórt.Test ")).toBe("shipsupporttest");
  expect(normalizeUsernamePolicy("voce deveriase matar")).toBe("vocedeveriasematar");
  await policy.replace({ reserved: "Shíp_Support", blocked: "Bád.Name, bad-name" });
  expect(await policy.list()).toEqual({ reserved: ["Shíp_Support"], blocked: ["Bád.Name"] });
  for (const name of ["shipsupport", "ship-support", "badname", "bad-name"]) expect(await signup.available(name)).toBe(false);
  for (const name of ["my-bad-name", "alicesmith", "alice-smith", "gay", "negro", "kike", "rape", "88"]) {
    expect(await signup.available(name)).toBe(true);
  }
  const principalId = await owner();
  for (const handle of ["alicesmith", "alice-smith"]) {
    expect((await accounts.reserveInstallation({ principalId, operationId: crypto.randomUUID(), handle })).handle).toBe(handle);
  }
});

it("seeds the supplied multilingual policy while leaving contextual and ordinary identities available", async () => {
  for (const name of ["ship-space", "shipsupport", "pt-br", "suporte", "maric-on", "white-power", "vocedeveriasematar", "sexocomcriancas"]) {
    expect(await signup.available(name)).toBe(false);
  }
  for (const name of ["kike", "coon", "dyke", "marica", "bicha", "rape", "groomer", "kys", "gay", "queer", "trans", "travesti",
    "negro", "preto", "moro", "judeu", "judio", "isis", "adolf", "aryan", "loli", "shota", "ss", "88", "cp", "csa"]) {
    expect(await signup.available(name)).toBe(true);
  }
  for (const entries of [initial.reserved, initial.blocked]) {
    expect(new Set(entries.map(normalizeUsernamePolicy)).size).toBe(entries.length);
  }
});

it("allows only operator-controlled creation of reserved names and never overrides a block", async () => {
  await policy.replace({ reserved: "official-test, both-lists", blocked: "blocked-test, both-lists" });
  const principalId = await owner();
  await expect(accounts.reserveInstallation({ principalId, operationId: crypto.randomUUID(), handle: "official-test" }))
    .rejects.toThrow("handle is unavailable");
  const { service } = admin();
  expect((await service.reserve({ operationId: crypto.randomUUID(), handle: "official-test" })).handle).toBe("official-test");
  for (const handle of ["blocked-test", "both-lists"]) {
    await expect(service.reserve({ operationId: crypto.randomUUID(), handle })).rejects.toThrow("handle is unavailable");
  }
});
