import { describe, expect, it } from "vitest";
import { zenAttachment, zenSendIntent } from "./zenAttachments";

describe("Zen attachment drafts", () => {
  it("keeps the File as a body and identifies its media kind", () => {
    const file = new File(["image bytes"], "image.png", { type: "image/png" });
    expect(zenAttachment(file)).toMatchObject({ body: file, type: "image", mimeType: "image/png", filename: "image.png" });
    expect(zenAttachment(new File([], "notes.txt"))).toMatchObject({ type: "document", mimeType: "application/octet-stream" });
  });

  it("retries one intent until its recipient, text or files change", () => {
    const file = zenAttachment(new File(["one"], "notes.txt"));
    const original = zenSendIntent(null, "proc:one", "Read this", [file]);
    expect(zenSendIntent(original, "proc:one", "Read this", [file])).toBe(original);
    expect(zenSendIntent(original, "proc:two", "Read this", [file]).idempotencyKey).not.toBe(original.idempotencyKey);
    expect(zenSendIntent(original, "proc:one", "Updated", [file]).idempotencyKey).not.toBe(original.idempotencyKey);
    expect(zenSendIntent(original, "proc:one", "Read this", []).idempotencyKey).not.toBe(original.idempotencyKey);
    const replacement = zenAttachment(new File(["two"], "notes.txt"));
    expect(zenSendIntent(original, "proc:one", "Read this", [replacement]).idempotencyKey).not.toBe(original.idempotencyKey);
  });

  it("keeps the selected target with a retry and creates a new intent when it changes", () => {
    const first = zenSendIntent(null, "ship", "Clean up my downloads.", [], "macbook");
    expect(zenSendIntent(first, "ship", first.text, [], "macbook")).toBe(first);
    const changed = zenSendIntent(first, "ship", first.text, [], "gsv");
    expect(changed.selectedTarget).toBe("gsv");
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(first.selectedTarget).toBe("macbook");
    expect(zenSendIntent(first, "ship", first.text, []).selectedTarget).toBeUndefined();
  });
});
