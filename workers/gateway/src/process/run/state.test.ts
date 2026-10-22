import { describe, expect, it } from "vitest";
import { generationRun, processTestConfig } from "../do-test-harness";
import { runStateSchema } from "./state";

describe("run state", () => {
  it("keeps built-in skills in the configuration a run stores", () => {
    const config = {
      ...processTestConfig("proc:state"),
      skillIndex: [{
        id: "memory",
        name: "memory",
        description: "Store and recall durable memory.",
        source: { kind: "system" as const, label: "system", writable: false },
      }],
    };

    expect(runStateSchema.parse(generationRun("run-state", config)).config?.skillIndex?.[0]?.source)
      .toEqual({ kind: "system", label: "system", writable: false });
  });
});
