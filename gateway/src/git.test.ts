import { describe, expect, it } from "vitest";
import { RIPGIT_INSTALLATION_HEADER } from "./installation/ripgit";
import { buildGitProxyRequest, matchGitPath } from "./git";

describe("Git proxy requests", () => {
  it("removes caller credentials and installation routing metadata", async () => {
    const request = new Request(
      "https://hank.gsv.space/git/alice/home/info/refs?service=git-upload-pack",
      {
        headers: {
          authorization: "Basic credential",
          cookie: "session=secret",
          [RIPGIT_INSTALLATION_HEADER]: "inst_other",
          "x-ripgit-actor-name": "spoofed",
        },
      },
    );
    const match = matchGitPath(new URL(request.url));
    expect(match).not.toBeNull();

    const proxied = await buildGitProxyRequest(request, match!, "alice");

    expect(proxied.url).toBe(
      "https://ripgit/alice/home/info/refs?service=git-upload-pack",
    );
    expect(proxied.headers.get("authorization")).toBeNull();
    expect(proxied.headers.get("cookie")).toBeNull();
    expect(proxied.headers.get(RIPGIT_INSTALLATION_HEADER)).toBeNull();
    expect(proxied.headers.get("x-ripgit-actor-name")).toBe("alice");
  });
});
