import { describe, expect, it } from "vitest";
import { limitShipCalls } from "./ship-call-limit";

const WORKER_ADDRESS = "2a06:98c0:3600::103";

function limiter(success = true) {
  const keys: string[] = [];
  return { keys, binding: { limit: async ({ key }: { key: string }) => (keys.push(key), { success }) } };
}

function call(headers: Record<string, string>): Request {
  return new Request("https://ada.ship.space/xrpc/space.ship.deliver", { method: "POST", headers });
}

describe("the Gateway's budget for calls to a Ship", () => {
  it("counts each address's calls to each Ship", async () => {
    const counted = limiter();
    expect(await limitShipCalls(call({ "cf-connecting-ip": "203.0.113.7" }), counted.binding, "inst_ada")).toBeNull();
    expect(await limitShipCalls(call({ "cf-connecting-ip": "203.0.113.7" }), counted.binding, "inst_bea")).toBeNull();
    expect(counted.keys).toEqual(["inst_ada 203.0.113.7", "inst_bea 203.0.113.7"]);
  });

  it("tells Workers on other zones apart by the zone Cloudflare names for them", async () => {
    const counted = limiter();
    await limitShipCalls(call({ "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "ship.space" }), counted.binding, "inst_ada");
    await limitShipCalls(call({ "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "other.example" }), counted.binding, "inst_ada");
    // Only calls from Cloudflare's Worker address carry a zone Cloudflare set; anyone else's is their own header.
    await limitShipCalls(call({ "cf-connecting-ip": "203.0.113.7", "cf-worker": "ship.space" }), counted.binding, "inst_ada");
    expect(counted.keys).toEqual([
      `inst_ada ${WORKER_ADDRESS} ship.space`,
      `inst_ada ${WORKER_ADDRESS} other.example`,
      "inst_ada 203.0.113.7",
    ]);
  });

  it("refuses a call over the budget with an XRPC error that says when to retry", async () => {
    const refused = await limitShipCalls(call({ "cf-connecting-ip": "203.0.113.7" }), limiter(false).binding, "inst_ada");
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("retry-after")).toBe("10");
    expect(await refused?.json()).toEqual({ error: "RateLimitExceeded", message: "Too many calls to this Ship; try again shortly" });
  });
});
