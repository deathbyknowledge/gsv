import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstanceStore } from "../src/store";
import type { BrowserHandoff } from "@humansandmachines/gsv/protocol";

describe("handoff retention", () => {
  it("compacts terminal history into indexed retry receipts without losing outcomes or linked work", () => runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const first: BrowserHandoff = { instanceId: "one", requestId: "old-0", tabId: 1, purpose: "Sign in", site: "https://example.com", state: "completed", revision: 3, createdAt: 1, expiresAt: 100, completedAt: 2, responsibilityId: "work", diagnosticRef: "expired-detail", activeTabId: 2 };
    for (let i = 0; i < 130; i++) store.putHandoff({ ...first, requestId: `old-${i}` });
    store.putHandoff({ ...first, requestId: "live", state: "active" });
    expect(store.liveHandoffs("one").map(value => value.requestId)).toEqual(["live"]);
    expect(store.handoff("one", "old-0")).toMatchObject({ state: "completed", purpose: first.purpose, responsibilityId: "work", completedAt: 2 });
    expect(store.handoff("one", "old-0")).not.toHaveProperty("diagnosticRef");
    expect(store.handoff("two", "old-0")).toBeUndefined();
    expect(store.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM handoffs").one().count).toBe(65);
    expect(store.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM handoff_receipts").one().count).toBe(66);
    store.putHandoff({ ...first, requestId: "new" });
    expect(store.handoff("one", "old-0")?.state).toBe("completed");
    expect(store.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM handoffs").one().count).toBe(65);
  }));
});
