import { describe, expect, it, vi } from "vitest";
import {
  APP_LAUNCH_TOKEN_MAX_BYTES,
  cancelAppLaunchRequestBody,
  readAppLaunchToken,
} from "./app-launch-token";

const TOKEN = "01234567-89ab-4def-8abc-0123456789ab";

describe("app launch token ingress", () => {
  it("accepts only the exact canonical JSON token envelope", async () => {
    const request = jsonRequest(JSON.stringify({ token: TOKEN }));

    await expect(readAppLaunchToken(request)).resolves.toEqual({
      ok: true,
      token: TOKEN,
    });
    expect(request.bodyUsed).toBe(true);
  });

  it.each([
    JSON.stringify({ token: ` ${TOKEN}` }),
    JSON.stringify({ token: TOKEN.toUpperCase() }),
    JSON.stringify({ token: "not-a-uuid" }),
    JSON.stringify({ token: TOKEN, extra: true }),
    JSON.stringify([TOKEN]),
    "not-json",
  ])("rejects a non-canonical token envelope", async (body) => {
    await expect(readAppLaunchToken(jsonRequest(body))).resolves.toEqual({
      ok: false,
      tooLarge: false,
    });
  });

  it("rejects and cancels a declared oversized body without pulling it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, {
      highWaterMark: 0,
    });
    const request = new Request("https://gsv.test/apps/session/launch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(APP_LAUNCH_TOKEN_MAX_BYTES + 1),
      },
      body,
    });

    await expect(readAppLaunchToken(request)).resolves.toEqual({
      ok: false,
      tooLarge: true,
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects and cancels a non-JSON body without pulling it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, {
      highWaterMark: 0,
    });
    const request = new Request("https://gsv.test/apps/session/launch", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });

    await expect(readAppLaunchToken(request)).resolves.toEqual({
      ok: false,
      tooLarge: false,
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a chunked body as soon as its cumulative size exceeds the cap", async () => {
    const cancel = vi.fn();
    const chunks = [
      new Uint8Array(APP_LAUNCH_TOKEN_MAX_BYTES),
      new Uint8Array(1),
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    const request = new Request("https://gsv.test/apps/session/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    await expect(readAppLaunchToken(request)).resolves.toEqual({
      ok: false,
      tooLarge: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an unread body rejected before parsing", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const request = new Request("https://gsv.test/apps/session/launch", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({ pull, cancel }, {
        highWaterMark: 0,
      }),
    });

    await cancelAppLaunchRequestBody(request, "App session route rejected");

    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function jsonRequest(body: string): Request {
  return new Request("https://gsv.test/apps/session/launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}
