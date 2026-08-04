import { describe, expect, it, vi } from "vitest";
import { createInstallationId, LEGACY_STANDALONE_INSTALLATION_ID } from "./identity";
import {
  createInstallationRipgit,
  RIPGIT_INSTALLATION_HEADER,
} from "./ripgit";

describe("installation ripgit binding", () => {
  it("preserves the historical standalone binding", () => {
    const binding = { fetch: vi.fn() } as unknown as Fetcher;
    expect(createInstallationRipgit(
      binding,
      LEGACY_STANDALONE_INSTALLATION_ID,
    )).toBe(binding);
  });

  it("overwrites untrusted routing metadata for managed requests", async () => {
    const installationId = createInstallationId();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json({
        installationId: request.headers.get(RIPGIT_INSTALLATION_HEADER),
        body: await request.text(),
      });
    });
    const binding = createInstallationRipgit({ fetch } as unknown as Fetcher, installationId);

    const response = await binding.fetch("https://ripgit/alice/home", {
      method: "POST",
      headers: { [RIPGIT_INSTALLATION_HEADER]: createInstallationId() },
      body: "payload",
    });

    await expect(response.json()).resolves.toEqual({
      installationId,
      body: "payload",
    });
  });

  it("routes identical repository paths with distinct installation identities", async () => {
    const routed: string[] = [];
    const binding = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        routed.push(request.headers.get(RIPGIT_INSTALLATION_HEADER) ?? "");
        return new Response(null, { status: 204 });
      }),
    } as unknown as Fetcher;
    const firstId = createInstallationId();
    const secondId = createInstallationId();

    await createInstallationRipgit(binding, firstId)
      .fetch("https://ripgit/hyperspace/repos/alice/home/refs");
    await createInstallationRipgit(binding, secondId)
      .fetch("https://ripgit/hyperspace/repos/alice/home/refs");

    expect(routed).toEqual([firstId, secondId]);
  });
});
