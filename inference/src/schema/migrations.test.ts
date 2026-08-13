import { describe, expect, it } from "vitest";
import { INFERENCE_MIGRATIONS } from "./migrations";

describe("managed inference schema migrations", () => {
  it("starts from a versioned SQLite baseline", () => {
    expect(INFERENCE_MIGRATIONS).toHaveLength(2);
    expect(INFERENCE_MIGRATIONS[0]).toMatchObject({
      id: 1,
      name: "initial_inference_schema",
    });
    expect(INFERENCE_MIGRATIONS[1]).toMatchObject({
      id: 2,
      name: "mail_intake_replay_results",
    });
  });
});
