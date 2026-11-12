import { describe, expect, it } from "vitest";
import { generationRun, processTestConfig } from "../do-test-harness";
import { runStateSchema } from "./state";

describe("run state", () => {
  it("still reads a stored run whose configuration carries the skill index", () => {
    const config = {
      ...processTestConfig("proc:state"),
      skillIndex: [{
        id: "memory",
        name: "memory",
        description: "Store and recall durable memory.",
        source: { kind: "system" as const, label: "system", writable: false },
      }],
      skillIndexMode: "summary" as const,
    };

    const stored = runStateSchema.parse(generationRun("run-state", config)).config;
    expect(stored).toMatchObject({ model: config.model });
    expect(stored).not.toHaveProperty("skillIndex");
    expect(stored).not.toHaveProperty("skillIndexMode");
  });
});
