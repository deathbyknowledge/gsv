import { describe, expect, it, vi } from "vitest";
import {
  buildTelegramReplyParameters,
  callTelegramApiWithMarkdownCaption,
  isTelegramFormattingError,
  markdownToTelegramHtml,
  sendTelegramMarkdownMessage,
} from "./telegram-formatting";

function formattingError(description = "Bad Request: can't parse entities"):
  Error & { telegramStatus: number; telegramDescription: string } {
  return Object.assign(new Error(description), {
    telegramStatus: 400,
    telegramDescription: description,
  });
}

describe("markdownToTelegramHtml", () => {
  it("renders common agent Markdown using Telegram-supported HTML", () => {
    const html = markdownToTelegramHtml([
      "# Summary",
      "",
      "Use **bold**, _italic_, ~~old~~, and `x < y`.",
      "",
      "- first",
      "- [x] done",
      "",
      "> quoted",
      "",
      "```ts",
      "const value = 1 < 2;",
      "```",
    ].join("\n"));

    expect(html).toContain("<b>Summary</b>");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<i>italic</i>");
    expect(html).toContain("<s>old</s>");
    expect(html).toContain("<code>x &lt; y</code>");
    expect(html).toContain("• first");
    expect(html).toContain("☑ done");
    expect(html).toContain("<blockquote>quoted</blockquote>");
    expect(html).toContain(
      "<pre><code class=\"language-ts\">const value = 1 &lt; 2;</code></pre>",
    );
  });

  it("escapes raw HTML and only emits safe links", () => {
    const html = markdownToTelegramHtml([
      "<script>alert('no')</script>",
      "",
      "[safe](https://example.com/?a=1&b=2)",
      "[unsafe](javascript:alert(1))",
    ].join("\n"));

    expect(html).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;");
    expect(html).toContain(
      "<a href=\"https://example.com/?a=1&amp;b=2\">safe</a>",
    );
    expect(html).toContain("unsafe");
    expect(html).not.toContain("javascript:");
  });

  it("keeps tables readable without unsupported table tags", () => {
    const html = markdownToTelegramHtml([
      "| Name | Value |",
      "| --- | --- |",
      "| **one** | 1 |",
    ].join("\n"));

    expect(html).toBe("<b>Name | Value</b>\n<b>one</b> | 1");
  });
});

describe("sendTelegramMarkdownMessage", () => {
  it("uses rich Markdown and current reply parameters", async () => {
    const callApi = vi.fn().mockResolvedValue({ message_id: 7 });

    await sendTelegramMarkdownMessage(callApi, "chat-1", "**hello**", 42);

    expect(callApi).toHaveBeenCalledWith("sendRichMessage", {
      chat_id: "chat-1",
      rich_message: { markdown: "**hello**" },
      reply_parameters: { message_id: 42 },
    });
  });

  it("falls back to safe HTML after a rich Markdown parse rejection", async () => {
    const callApi = vi.fn()
      .mockRejectedValueOnce(formattingError())
      .mockResolvedValueOnce({ message_id: 8 });

    await sendTelegramMarkdownMessage(callApi, "chat-1", "**hello**");

    expect(callApi).toHaveBeenNthCalledWith(2, "sendMessage", {
      chat_id: "chat-1",
      text: "<b>hello</b>",
      parse_mode: "HTML",
    });
  });

  it("falls back to unparsed text if both formatting modes are rejected", async () => {
    const callApi = vi.fn()
      .mockRejectedValueOnce(formattingError())
      .mockRejectedValueOnce(formattingError("unsupported start tag"))
      .mockResolvedValueOnce({ message_id: 9 });

    await sendTelegramMarkdownMessage(callApi, "chat-1", "**hello**");

    expect(callApi).toHaveBeenNthCalledWith(3, "sendMessage", {
      chat_id: "chat-1",
      text: "**hello**",
    });
  });

  it("does not retry ambiguous or non-formatting failures", async () => {
    const error = new Error("network connection lost");
    const callApi = vi.fn().mockRejectedValue(error);

    await expect(
      sendTelegramMarkdownMessage(callApi, "chat-1", "hello"),
    ).rejects.toBe(error);
    expect(callApi).toHaveBeenCalledTimes(1);
  });
});

describe("buildTelegramReplyParameters", () => {
  it("only creates reply parameters for finite message ids", () => {
    expect(buildTelegramReplyParameters(42)).toEqual({ message_id: 42 });
    expect(buildTelegramReplyParameters(Number.NaN)).toBeUndefined();
    expect(buildTelegramReplyParameters()).toBeUndefined();
  });
});

describe("callTelegramApiWithMarkdownCaption", () => {
  it("formats media captions as Telegram HTML", async () => {
    const callApi = vi.fn().mockResolvedValue({ message_id: 10 });

    await callTelegramApiWithMarkdownCaption(
      callApi,
      "sendPhoto",
      "**caption**",
      (caption, parseMode) => ({ caption, parse_mode: parseMode }),
    );

    expect(callApi).toHaveBeenCalledWith("sendPhoto", {
      caption: "<b>caption</b>",
      parse_mode: "HTML",
    });
  });

  it("retries rejected caption formatting without a parse mode", async () => {
    const callApi = vi.fn()
      .mockRejectedValueOnce(formattingError())
      .mockResolvedValueOnce({ message_id: 11 });

    await callTelegramApiWithMarkdownCaption(
      callApi,
      "sendDocument",
      "**caption**",
      (caption, parseMode) => ({ caption, parse_mode: parseMode }),
    );

    expect(callApi).toHaveBeenNthCalledWith(2, "sendDocument", {
      caption: "**caption**",
      parse_mode: undefined,
    });
  });
});

describe("isTelegramFormattingError", () => {
  it("requires an explicit Telegram 400 formatting response", () => {
    expect(isTelegramFormattingError(formattingError())).toBe(true);
    expect(isTelegramFormattingError(Object.assign(formattingError(), {
      telegramStatus: 500,
    }))).toBe(false);
    expect(isTelegramFormattingError(new Error("can't parse entities"))).toBe(false);
  });
});
