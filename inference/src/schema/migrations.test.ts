import { describe, expect, it } from "vitest";
import { INFERENCE_MIGRATIONS } from "./migrations";

describe("managed inference schema migrations", () => {
  it("starts from a versioned SQLite baseline", () => {
    expect(INFERENCE_MIGRATIONS).toHaveLength(1);
    expect(INFERENCE_MIGRATIONS[0]).toMatchObject({
      id: 1,
      name: "initial_inference_schema",
    });
  });
});
