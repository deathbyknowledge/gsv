import { describe, expect, it } from "vitest";
import { MAIL_MIGRATIONS } from "../src/schema/migrations";

describe("managed mail schema migrations", () => {
  it("starts from a versioned SQLite baseline", () => {
    expect(MAIL_MIGRATIONS).toEqual([
      expect.objectContaining({
        id: 1,
        name: "initial_mail_transport_schema",
      }),
      expect.objectContaining({
        id: 2,
        name: "staged_mail_intake",
      }),
      expect.objectContaining({
        id: 3,
        name: "mail_summary_generation",
      }),
    ]);
  });
});
