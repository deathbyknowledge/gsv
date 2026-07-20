import { describe, expect, it } from "vitest";
import {
  adapterInboundRouteMetadata,
  normalizeAdapterInboundRouteMetadata,
} from "./adapter-inbound-route";

describe("adapter inbound route metadata", () => {
  it("extracts only the bounded routing envelope from a full frame", () => {
    const metadata = adapterInboundRouteMetadata({
      type: "req",
      id: "request-1",
      call: "adapter.inbound",
      args: {
        adapter: " Discord ",
        accountId: " primary ",
        message: {
          messageId: "private-message-id",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: " actor-1 ", name: "Private Person" },
          text: "private text",
          media: [{
            type: "image",
            mimeType: "image/png",
            data: "private media",
          }],
        },
      },
    });

    expect(metadata).toEqual({
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      frameId: "request-1",
      surfaceKind: "dm",
      surfaceId: "dm-1",
    });
    expect(JSON.stringify(metadata)).not.toContain("private");
  });

  it("uses the DM surface id only as the missing actor fallback", () => {
    const dm = adapterInboundRouteMetadata({
      type: "req",
      id: "request-1",
      call: "adapter.inbound",
      args: {
        adapter: "discord",
        accountId: "primary",
        message: {
          messageId: "message-1",
          surface: { kind: "dm", id: "dm-actor" },
          text: "hello",
        },
      },
    });
    const group = adapterInboundRouteMetadata({
      type: "req",
      id: "request-2",
      call: "adapter.inbound",
      args: {
        adapter: "discord",
        accountId: "primary",
        message: {
          messageId: "message-2",
          surface: { kind: "group", id: "group-1" },
          text: "hello",
        },
      },
    });

    expect(dm?.actorId).toBe("dm-actor");
    expect(group).toBeNull();
  });

  it("rejects oversized, non-canonical, and payload-bearing route inputs", () => {
    const valid = {
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      frameId: "request-1",
      surfaceKind: "dm" as const,
      surfaceId: "dm-1",
    };

    expect(normalizeAdapterInboundRouteMetadata(valid)).toEqual(valid);
    expect(normalizeAdapterInboundRouteMetadata({
      ...valid,
      actorId: "a".repeat(513),
    })).toBeNull();
    expect(normalizeAdapterInboundRouteMetadata({
      ...valid,
      surfaceId: " dm-1 ",
    })).toBeNull();
    expect(normalizeAdapterInboundRouteMetadata({
      ...valid,
      message: { text: "must not cross" },
    })).toBeNull();
  });
});
