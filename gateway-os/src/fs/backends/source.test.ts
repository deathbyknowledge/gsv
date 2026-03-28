import { describe, expect, it, vi } from "vitest";
import { createSourceBackend } from "./source";

function makeConfig(entries: Record<string, string>) {
  return {
    get(key: string): string | null {
      return key in entries ? entries[key] : null;
    },
  };
}

function makeEnv() {
  const fetch = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.searchParams.get("path") ?? "";

    if (url.pathname.endsWith("/read")) {
      if (path === "") {
        return new Response(
          JSON.stringify([
            { name: "README.md", mode: "100644", hash: "1", type: "blob" },
            { name: "src", mode: "040000", hash: "2", type: "tree" },
          ]),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "src") {
        return new Response(
          JSON.stringify([
            { name: "index.ts", mode: "100644", hash: "3", type: "blob" },
          ]),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "README.md") {
        return new Response("hello from source mirror", {
          headers: { "X-Blob-Size": "24" },
        });
      }

      if (path === "src/index.ts") {
        return new Response("export const answer = 42;\n", {
          headers: { "X-Blob-Size": "26" },
        });
      }

      return new Response("missing", { status: 404 });
    }

    if (url.pathname.endsWith("/search")) {
      return Response.json({
        ok: true,
        matches: [
          {
            path: "src/index.ts",
            line: 1,
            content: "export const answer = 42;",
          },
        ],
      });
    }

    return new Response("unexpected", { status: 500 });
  });

  return {
    env: {
      RIPGIT: { fetch } as unknown as Fetcher,
      RIPGIT_INTERNAL_KEY: "test-key",
    } as Env,
    fetch,
  };
}

describe("SourceMountBackend", () => {
  it("returns null when the deployment source mirror is not configured", () => {
    const { env } = makeEnv();
    const backend = createSourceBackend(env, makeConfig({}));
    expect(backend).toBeNull();
  });

  it("reads and lists the configured /src/gsv mirror", async () => {
    const { env } = makeEnv();
    const backend = createSourceBackend(
      env,
      makeConfig({
        "config/deploy/source_owner": "theagentscompany",
        "config/deploy/source_repo": "gsv",
        "config/deploy/source_ref": "main",
      }),
    );

    expect(backend).not.toBeNull();
    expect(await backend!.readdir("/src")).toEqual(["gsv"]);
    expect(await backend!.readdir("/src/gsv")).toEqual(["README.md", "src"]);
    expect(await backend!.readFile("/src/gsv/README.md")).toBe("hello from source mirror");
    await expect(backend!.writeFile("/src/gsv/README.md", "nope")).rejects.toThrow("read-only source mirror");
  });

  it("maps ripgit search results back into /src/gsv paths", async () => {
    const { env } = makeEnv();
    const backend = createSourceBackend(
      env,
      makeConfig({
        "config/deploy/source_owner": "theagentscompany",
        "config/deploy/source_repo": "gsv",
      }),
    );

    expect(backend).not.toBeNull();
    const result = await backend!.search!("/src/gsv/src", "answer");
    expect(result).toEqual({
      matches: [
        {
          path: "/src/gsv/src/index.ts",
          line: 1,
          content: "export const answer = 42;",
        },
      ],
      truncated: undefined,
    });
  });
});
