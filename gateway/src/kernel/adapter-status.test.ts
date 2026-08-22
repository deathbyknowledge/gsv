import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getDurableObjectByName } from "../shared/durable-object";
import type { Kernel } from "./do";
import type { AdapterStatusStore } from "./adapter-status";

describe("AdapterStatusStore ownership", () => {
  it("preserves owners across service status updates", async () => {
    const kernel = await getDurableObjectByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(kernel, (instance: Kernel) => {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      const status = (instance as {
        adapters: { status: AdapterStatusStore };
      }).adapters.status;

      status.setOwner("whatsapp", "primary", 1000);
      status.upsert("whatsapp", "primary", {
        accountId: "primary",
        connected: true,
        authenticated: true,
      });
      status.upsert("telegram", "bot", {
        accountId: "bot",
        connected: false,
        authenticated: false,
      });

      expect(status.get("whatsapp", "primary")).toMatchObject({ ownerUid: 1000 });
      expect(status.get("telegram", "bot")).toMatchObject({ ownerUid: null });
      expect(status.listByOwner(1000).map((record) => record.accountId)).toEqual(["primary"]);

      status.beginLifecycle("telegram", "bot");
      expect(() => status.beginLifecycle("telegram", "bot")).toThrow("lifecycle operation");
      status.endLifecycle("telegram", "bot");
      expect(() => status.beginLifecycle("telegram", "bot")).not.toThrow();
      status.endLifecycle("telegram", "bot");
    });
  });
});
