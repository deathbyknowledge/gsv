import { describe, expect, it } from "vitest";
import { selectContactSendIntent } from "./ContactsPage";

describe("contact send intents", () => {
  const attachment = {
    id: "attachment:one",
    label: "one.png",
    type: "image" as const,
    mimeType: "image/png",
    filename: "one.png",
    body: new Blob(["one"]),
  };

  it("reuses one identity for the same restored draft", () => {
    const first = selectContactSendIntent(null, "contact:one", "Hello", [attachment]);

    expect(selectContactSendIntent(first, "contact:one", "Hello", [attachment])).toBe(first);
  });

  it("creates a new identity when the draft meaning changes", () => {
    const first = selectContactSendIntent(null, "contact:one", "Hello", [attachment]);
    const anotherContact = selectContactSendIntent(first, "contact:two", "Hello", [attachment]);
    const edited = selectContactSendIntent(first, "contact:one", "Hello again", [attachment]);
    const reattached = selectContactSendIntent(first, "contact:one", "Hello", [{
      ...attachment,
      id: "attachment:two",
    }]);

    expect(anotherContact.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(edited.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(reattached.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
