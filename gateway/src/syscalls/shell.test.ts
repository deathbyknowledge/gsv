import { describe, expect, it } from "vitest";
import { SHELL_EXEC_DEFINITION } from "./shell";

describe("Shell tool definition", () => {
  it("bootstraps task-first capability discovery without enumerating commands", () => {
    expect(SHELL_EXEC_DEFINITION.description).toContain(
      "man --search -- '<plain-language goal>'",
    );
    expect(SHELL_EXEC_DEFINITION.description).toContain("NEXT action");
    expect(SHELL_EXEC_DEFINITION.description).not.toContain("txt2img");
  });

  it("exposes a literal argument channel for opaque payloads", () => {
    const argv = SHELL_EXEC_DEFINITION.inputSchema.properties.argv;

    expect(argv).toMatchObject({ type: "array", items: { type: "string" } });
    expect(argv.description).toContain("without shell expansion");
    expect(argv.description).toContain("proc delegate");
  });
});
