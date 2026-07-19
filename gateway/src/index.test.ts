import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import {
  isRetiredCliDownloadPath,
  packageAppClientResponseHeaders,
  packageWorkerPath,
  trustedLoginSourceAddress,
} from "./index";
import { AuthStore } from "./kernel/auth-store";
import type { Kernel } from "./kernel/do";
import { SHIP_KERNEL_NAME } from "./shared/utils";

describe("gateway public routes", () => {
  it("retires only the old CLI mirror path", () => {
    expect(isRetiredCliDownloadPath("/public/gsv/downloads/cli/install.sh")).toBe(true);
    expect(isRetiredCliDownloadPath("/public/gsv/downloads/cli-old/install.sh")).toBe(false);
    expect(isRetiredCliDownloadPath("/public/gsv/assets/app.js")).toBe(false);
  });

  it("reads login source only from Cloudflare's edge-authored header", () => {
    const request = new Request("https://gsv.test/git/root/repo.git/info/refs", {
      headers: {
        "CF-Connecting-IP": "203.0.113.8",
        "X-GSV-Login-Source": "attacker-controlled",
      },
    });

    expect(trustedLoginSourceAddress(request)).toBe("203.0.113.8");
  });

  it("forwards distinct Git request sources into pseudonymous limiter scopes", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
    });

    const authorization = `Basic ${btoa("root:wrong-credential")}`;
    for (const source of ["203.0.113.8", "203.0.113.9"]) {
      const response = await SELF.fetch(
        "https://gsv.test/git/root/private.git/git-receive-pack",
        {
          method: "POST",
          headers: {
            authorization,
            "CF-Connecting-IP": source,
          },
        },
      );
      expect(response.status).toBe(401);
    }

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const scopes = state.storage.sql.exec<{ scope: string }>(
        "SELECT scope FROM auth_login_attempts WHERE scope LIKE 'target:%' ORDER BY scope",
      ).toArray().map((row) => row.scope);
      expect(scopes).toHaveLength(2);
      expect(scopes[0]).not.toBe(scopes[1]);
      expect(scopes.join(" ")).not.toContain("203.0.113");
    });
  });

  it("rejects an oversized Git Authorization header before Basic decoding", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    const before = await runInDurableObject(kernel, async (_instance: Kernel, state) => (
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM auth_login_attempts",
      ).one().count
    ));
    const response = await SELF.fetch(
      "https://gsv.test/git/root/private.git/git-receive-pack",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${"A".repeat(5_000)}`,
          "CF-Connecting-IP": "203.0.113.8",
        },
      },
    );
    expect(response.status).toBe(401);

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM auth_login_attempts",
      ).one().count).toBe(before);
    });
  });
});

describe("gateway app session routing", () => {
  it("preserves the package app root slash when proxying app sessions", () => {
    expect(packageWorkerPath("/apps/chat", "/")).toBe("/apps/chat/");
    expect(packageWorkerPath("/apps/chat", "")).toBe("/apps/chat/");
  });

  it("keeps nested app session paths under the package route", () => {
    expect(packageWorkerPath("/apps/chat", "/assets/main.js")).toBe("/apps/chat/assets/main.js");
  });

  it("strips package-controlled cookie headers from app session responses", () => {
    const headers = packageAppClientResponseHeaders(new Response("ok", {
      headers: {
        "content-length": "2",
        "set-cookie": "gsv_session=bad",
        "set-cookie2": "gsv_legacy=bad",
        "x-package": "ok",
      },
    }));

    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("set-cookie2")).toBeNull();
    expect(headers.get("x-package")).toBe("ok");
  });
});
