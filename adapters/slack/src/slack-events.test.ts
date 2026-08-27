import { describe, expect, it } from "vitest";
import { normalizeSlackEvent } from "./slack-events";

const BOT = "UGSVBOT1";

type SlackEventFixture = {
  type: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  subtype?: string;
};

function envelope(event: SlackEventFixture) {
  return {
    type: "event_callback",
    team_id: "TWORK123",
    api_app_id: "AGSV1234",
    event_id: "EvEVENT123",
    event_time: 1_700_000_000,
    event,
  };
}

describe("Slack event normalization", () => {
  it("turns a public app mention into an addressed thread surface", () => {
    expect(normalizeSlackEvent(envelope({
      type: "app_mention",
      user: "UALICE01",
      channel: "CGENERAL1",
      text: `<@${BOT}> help &amp; explain`,
      ts: "1700000000.000100",
      event_ts: "1700000000.000100",
    }), BOT)).toEqual({
      kind: "accepted",
      inbound: {
        deliveryId: "event:EvEVENT123",
        eventId: "EvEVENT123",
        teamId: "TWORK123",
        messageId: "1700000000.000100",
        actorId: "UALICE01",
        surface: {
          kind: "channel",
          id: "CGENERAL1",
          threadId: "1700000000.000100",
        },
        text: "help & explain",
        replyToId: undefined,
        timestamp: 1_700_000_000_000,
        wasMentioned: true,
      },
    });
  });

  it("preserves a direct-message thread without requiring a mention", () => {
    expect(normalizeSlackEvent(envelope({
      type: "message",
      channel_type: "im",
      user: "UBOB0001",
      channel: "DBOB0001",
      text: "hello",
      ts: "1700000001.000200",
      thread_ts: "1700000000.000100",
    }), BOT)).toMatchObject({
      kind: "accepted",
      inbound: {
        actorId: "UBOB0001",
        surface: {
          kind: "dm",
          id: "DBOB0001",
          threadId: "1700000000.000100",
        },
        text: "hello",
      },
    });
  });

  it("ignores bot messages and message subtypes", () => {
    expect(normalizeSlackEvent(envelope({
      type: "message",
      channel_type: "im",
      user: BOT,
      channel: "DGSVBOT1",
      text: "loop",
      ts: "1700000001.000200",
    }), BOT)).toEqual({ kind: "ignored" });
    expect(normalizeSlackEvent(envelope({
      type: "message",
      channel_type: "im",
      user: "UALICE01",
      channel: "DALICE01",
      text: "edited",
      ts: "1700000001.000200",
      subtype: "message_changed",
    }), BOT)).toEqual({ kind: "ignored" });
  });

  it("recognizes workspace uninstall events without inventing an actor", () => {
    expect(normalizeSlackEvent(envelope({ type: "app_uninstalled" }), BOT)).toEqual({
      kind: "uninstalled",
      teamId: "TWORK123",
      eventId: "EvEVENT123",
    });
  });
});
