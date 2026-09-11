import { describe, expect, it } from "vitest";
import { discordHelloSchema, discordMessagePayloadSchema, discordReadyPayloadSchema, parseDiscordGatewayFrame } from "./discord-events";

describe("Discord provider packet boundaries", () => {
  it("decodes connection controls independently from message dispatches", () => {
    const hello = parseDiscordGatewayFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    expect(discordHelloSchema.parse(hello.d).heartbeat_interval).toBe(45_000);
    expect(parseDiscordGatewayFrame(JSON.stringify({ op: 11, d: null }))).toEqual({ op: 11, d: null });
    expect(parseDiscordGatewayFrame(JSON.stringify({ op: 9, d: false }))).toEqual({ op: 9, d: false });
    const ready = parseDiscordGatewayFrame(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "123", username: "bot" } } }));
    expect(discordReadyPayloadSchema.parse(ready.d).session_id).toBe("session");
    expect(() => discordMessagePayloadSchema.parse(ready.d)).toThrow();
  });

  it("requires message identity at the message boundary and rejects malformed control packets", () => {
    const packet = parseDiscordGatewayFrame(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "message", channel_id: "channel", author: { id: "actor", username: "person" }, content: "hello" } }));
    expect(discordMessagePayloadSchema.parse(packet.d)).toMatchObject({ id: "message", channel_id: "channel" });
    expect(() => discordMessagePayloadSchema.parse({ content: "no identity" })).toThrow();
    expect(() => discordHelloSchema.parse({ heartbeat_interval: -1 })).toThrow();
    expect(() => parseDiscordGatewayFrame('{"op":"10"}')).toThrow();
  });
});
