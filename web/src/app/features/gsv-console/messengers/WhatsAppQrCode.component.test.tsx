import type { VNode } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  setImageUrl: vi.fn(),
}));

import { WhatsAppQrCode, type WhatsAppQrCodeDependencies } from "./WhatsAppQrCode";

const dependencies: WhatsAppQrCodeDependencies = {
  useEffect: () => undefined,
  useState: (initialValue: string | (() => string)) => [
    initialValue instanceof Function ? initialValue() : initialValue,
    hooks.setImageUrl,
  ],
};

beforeEach(() => {
  hooks.setImageUrl.mockReset();
});

describe("WhatsAppQrCode", () => {
  it("reports browser image load failures to its owner", () => {
    const onRenderError = vi.fn();
    const rendered = WhatsAppQrCode({
      source: { kind: "data-url", value: "data:image/png;base64,AAAA" },
      onRenderError,
      dependencies,
    });
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const image = rendered.props.children as VNode<{ onError: () => void }>;

    expect(image.type).toBe("img");
    image.props.onError();

    expect(hooks.setImageUrl).toHaveBeenCalledWith("");
    expect(onRenderError).toHaveBeenCalledOnce();
  });
});
