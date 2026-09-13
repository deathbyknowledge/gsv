import { describe, expect, it, vi } from "vitest";
import {
  createInstallationRipgit,
  removeUntrustedRipgitInstallationHeader,
  RIPGIT_INSTALLATION_HEADER,
} from "./ripgit";

describe("installation ripgit binding", () => {
  it("requires validated installation metadata for every binding", () => {
    expect(() => createInstallationRipgit({ fetch: vi.fn() }, ""))
      .toThrow("installationId is invalid");
  });

  it("overwrites untrusted installation routing metadata", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json({
        installationId: request.headers.get(RIPGIT_INSTALLATION_HEADER),
        body: await request.text(),
      });
    });
    const binding = createInstallationRipgit({ fetch }, "inst_first");

    const response = await binding.fetch("https://ripgit/alice/home", {
      method: "POST",
      headers: { [RIPGIT_INSTALLATION_HEADER]: "inst_other" },
      body: "payload",
    });

    await expect(response.json()).resolves.toEqual({
      installationId: "inst_first",
      body: "payload",
    });
  });

  it("routes the same repository path with distinct installation identities", async () => {
    const routed: string[] = [];
    const binding = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        routed.push(request.headers.get(RIPGIT_INSTALLATION_HEADER) ?? "");
        return new Response(null, { status: 204 });
      }),
    };

    await createInstallationRipgit(binding, "inst_first")
      .fetch("https://ripgit/hyperspace/repos/alice/home/refs");
    await createInstallationRipgit(binding, "inst_second")
      .fetch("https://ripgit/hyperspace/repos/alice/home/refs");

    expect(routed).toEqual(["inst_first", "inst_second"]);
  });

  it("removes caller-provided installation routing metadata", () => {
    const headers = new Headers({ [RIPGIT_INSTALLATION_HEADER]: "inst_other" });
    removeUntrustedRipgitInstallationHeader(headers);
    expect(headers.has(RIPGIT_INSTALLATION_HEADER)).toBe(false);
  });
});
