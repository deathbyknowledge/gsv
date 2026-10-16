import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { AccountStore } from "./store";
import { PublicationHostStore } from "./publications";

it("admits only registered publication hosts and never moves them during installation reset", async () => {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "spaces.example");
  const owner = await accounts.createPrincipal({ email: "sites@example.com", displayName: "Owner", verified: true });
  const first = await accounts.reserveInstallation({ principalId: owner.id, operationId: "site-create", handle: "publisher" });
  const sites = new PublicationHostStore(env.INSTALLATIONS_DB, "usercontent.example");
  const siteId = `site-${"a".repeat(32)}`;
  const input = { installationId: first.installationId, siteId, slug: "demo" };
  await expect(sites.register(input)).rejects.toThrow("unavailable");
  await env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(first.installationId).run();
  await env.INSTALLATIONS_DB.prepare("UPDATE hostnames SET state = 'active' WHERE installation_id = ?").bind(first.installationId).run();
  const { origin } = await sites.register(input);
  expect(await sites.register(input)).toEqual({ origin });
  const renamed = new PublicationHostStore(env.INSTALLATIONS_DB, "new-content.example");
  expect(await renamed.register(input)).toEqual({ origin });
  expect(await renamed.resolve(new URL(origin).hostname)).toMatchObject({ installationId: first.installationId, publication: { siteId } });
  await expect(sites.register({ ...input, slug: "different" })).rejects.toThrow("unavailable");
  expect(await sites.resolve(new URL(origin).hostname)).toMatchObject({
    installationId: first.installationId, state: "active", publication: { siteId, slug: "demo" },
  });
  for (const hostname of ["unknown.usercontent.example", `${siteId}.usercontent.example.attacker.example`, `nested.${siteId}.usercontent.example`]) {
    expect(await sites.resolve(hostname)).toEqual({ found: false });
  }
  const reset = await accounts.resetInstallation({ installationId: first.installationId, operationId: "site-reset", confirmHandle: "publisher" });
  expect(reset.installationId).not.toBe(first.installationId);
  expect(await accounts.resolveHostname("publisher.spaces.example")).toMatchObject({ installationId: reset.installationId });
  expect(await sites.resolve(new URL(origin).hostname)).toMatchObject({ installationId: first.installationId, state: "retained" });
  expect(await new PublicationHostStore(env.INSTALLATIONS_DB).resolve(new URL(origin).hostname)).toEqual({ found: false });
  await expect(new PublicationHostStore(env.INSTALLATIONS_DB).register(input)).rejects.toThrow("not configured");
});

it("registers the largest configured publication domain as a valid full hostname", async () => {
  const domain = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(23)].join(".");
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "spaces.example");
  const owner = await accounts.createPrincipal({ email: "long-domain@example.com", displayName: "Owner", verified: true });
  const installation = await accounts.reserveInstallation({ principalId: owner.id, operationId: "long-domain", handle: "long-domain" });
  await env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(installation.installationId).run();
  const input = { installationId: installation.installationId, siteId: `site-${"b".repeat(32)}`, slug: "demo" };
  const sites = new PublicationHostStore(env.INSTALLATIONS_DB, domain);
  const { origin } = await sites.register(input);
  const hostname = new URL(origin).hostname;
  expect(hostname).toHaveLength(253);
  expect(await sites.resolve(hostname)).toMatchObject({ installationId: installation.installationId, publication: { siteId: input.siteId } });
  await expect(new PublicationHostStore(env.INSTALLATIONS_DB, domain + "x").register(input)).rejects.toThrow("Publication hostname is invalid");
});
