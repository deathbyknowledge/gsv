import type { VNode } from "preact";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../chat/components/ChatMediaAttachment", () => ({
  ChatMediaAttachment: () => null,
}));

import { ChatMediaAttachment } from "../../chat/components/ChatMediaAttachment";
import { TextClientMedia } from "./TextClientMedia";

type AttachmentNode = VNode<{
  media: unknown;
  processId: string;
}>;

describe("TextClientMedia", () => {
  it("forwards every moment attachment to the process-scoped body loader", () => {
    const items = [
      { type: "image", key: "media/image" },
      { type: "document", key: "media/document" },
    ];
    const rendered = TextClientMedia({
      items,
      momentKey: "moment:7",
      processId: "proc:7",
    });
    const children = rendered?.props.children as AttachmentNode[];

    expect(rendered?.props.class).toBe("text-client-media");
    expect(rendered?.props["aria-label"]).toBe("2 attachments");
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.type)).toEqual([
      ChatMediaAttachment,
      ChatMediaAttachment,
    ]);
    expect(children.map((child) => child.props)).toEqual([
      expect.objectContaining({ media: items[0], processId: "proc:7" }),
      expect.objectContaining({ media: items[1], processId: "proc:7" }),
    ]);
  });

  it("renders nothing for a moment without attachments", () => {
    expect(TextClientMedia({
      items: [],
      momentKey: "moment:empty",
      processId: "proc:7",
    })).toBeNull();
  });
});
