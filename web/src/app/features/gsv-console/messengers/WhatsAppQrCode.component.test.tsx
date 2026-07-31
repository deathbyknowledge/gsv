import type { VNode } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  setImageUrl: vi.fn(),
}));

vi.mock("preact/hooks", () => ({
  useEffect: () => undefined,
  useState: (initialValue: string) => [initialValue, hooks.setImageUrl],
}));

import { WhatsAppQrCode } from "./WhatsAppQrCode";

beforeEach(() => {
  hooks.setImageUrl.mockReset();
});

describe("WhatsAppQrCode", () => {
  it("reports browser image load failures to its owner", () => {
    const onRenderError = vi.fn();
    const rendered = WhatsAppQrCode({
      source: { kind: "data-url", value: "data:image/png;base64,AAAA" },
      onRenderError,
    });
    const image = rendered.props.children as VNode<{ onError: () => void }>;

    expect(image.type).toBe("img");
    image.props.onError();

    expect(hooks.setImageUrl).toHaveBeenCalledWith("");
    expect(onRenderError).toHaveBeenCalledOnce();
  });
});
