import { describe, expect, it, vi } from "vitest";

import {
  sendTelegramMediaGroupMessage,
  sendTelegramMediaMessage,
} from "./telegram-outbound-media";

describe("Telegram outbound media", () => {
  it("uploads a binary voice response with its filename and caption", async () => {
    const callApi = vi.fn(async () => ({ message_id: 42 }));
    await expect(sendTelegramMediaMessage(
      callApi,
      "12345",
      {
        type: "audio",
        mimeType: "audio/ogg",
        filename: "reply.ogg",
        body: { offset: 0, length: 4 },
      },
      new Uint8Array([1, 2, 3, 4]),
      "audio **reply**",
      7,
    )).resolves.toEqual({ message_id: 42 });

    expect(callApi).toHaveBeenCalledOnce();
    const [method, payload] = callApi.mock.calls[0]!;
    expect(method).toBe("sendAudio");
    expect(payload).toBeInstanceOf(FormData);
    if (!(payload instanceof FormData)) {
      throw new Error("expected multipart media payload");
    }
    const form = payload;
    expect(form.get("chat_id")).toBe("12345");
    expect(form.get("caption")).toBe("audio <b>reply</b>");
    expect(form.get("reply_parameters")).toBe('{"message_id":7}');
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      throw new Error("expected uploaded audio file");
    }
    expect(audio.name).toBe("reply.ogg");
    expect(audio.type).toBe("audio/ogg");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("sends compatible URL attachments as a Telegram media group", async () => {
    const callApi = vi.fn(async () => [{ message_id: 43 }, { message_id: 44 }]);
    await expect(sendTelegramMediaGroupMessage(
      callApi,
      "12345",
      [
        { type: "image", mimeType: "image/jpeg", url: "https://example.com/one.jpg" },
        { type: "video", mimeType: "video/mp4", url: "https://example.com/two.mp4" },
      ],
      [undefined, undefined],
      "a group",
    )).resolves.toEqual([{ message_id: 43 }, { message_id: 44 }]);

    expect(callApi).toHaveBeenCalledWith("sendMediaGroup", expect.objectContaining({
      chat_id: "12345",
      media: [
        {
          type: "photo",
          media: "https://example.com/one.jpg",
          caption: "a group",
          parse_mode: "HTML",
        },
        { type: "video", media: "https://example.com/two.mp4" },
      ],
    }));
  });
});
