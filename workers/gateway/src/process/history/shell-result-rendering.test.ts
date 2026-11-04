import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { renderToolResultOutput } from "./event-renderer";
import { renderModelHistoryGroup, type ModelHistoryGroup } from "./model-renderer";

describe("shell results in model context", () => {
  it("shows a finished command as its exit code and streams, each once", () => {
    const stdout = "# Notes\n- call the landlord\n";
    const stderr = "cat: missing.md: No such file or directory\n";
    expect(rendered({
      status: "failed", output: stdout + stderr, exitCode: 1, error: stderr.trim(),
      truncated: false, ok: true, pid: 0, stdout, stderr,
    })).toBe([
      "exit 1",
      "stdout:",
      "# Notes",
      "- call the landlord",
      "stderr:",
      "cat: missing.md: No such file or directory",
    ].join("\n"));
    expect(rendered({
      status: "completed", output: "notes.md\n", exitCode: 0, truncated: false, ok: true, pid: 0, stdout: "notes.md\n", stderr: "",
    })).toBe("exit 0\nstdout:\nnotes.md");
    expect(rendered({ status: "completed", output: "", exitCode: 0, stdout: "", stderr: "" })).toBe("exit 0");
  });

  it("keeps what the exit code doesn't say: why it stopped, a running session, a cut-off output", () => {
    expect(rendered({ status: "failed", output: "", error: "Command timed out after 30000ms" }))
      .toBe("failed: Command timed out after 30000ms");
    expect(rendered({
      status: "failed", output: "", error: "Command failed: SIGKILL", sessionId: "s1", stdout: "", stderr: "",
    })).toBe("failed: Command failed: SIGKILL");
    expect(rendered({ status: "failed", output: "", exitCode: 2, error: "Command exited with code 2", stdout: "", stderr: "" }))
      .toBe("exit 2");
    expect(rendered({ status: "running", output: "building\n", sessionId: "s1" }))
      .toBe("running in session s1\nbuilding");
    expect(rendered({ status: "completed", output: "a\n...[truncated]", exitCode: 0, truncated: true, stdout: "a\n...[truncated]", stderr: "" }))
      .toBe("exit 0\nstdout:\na\n...[truncated]\noutput truncated");
  });

  it("shows a target's combined output when it doesn't split the streams", () => {
    expect(rendered({ status: "completed", output: "hello\n", exitCode: 0 })).toBe("exit 0\nhello");
  });

  it("leaves other results, and shell output it can't read, as stored", () => {
    expect(rendered({ status: "done", files: 3 })).toBe('{"status":"done","files":3}');
    expect(rendered({ status: "completed", output: "x", exitCode: 0 }, "Read")).toBe('{"status":"completed","output":"x","exitCode":0}');
  });
});

function rendered(output: JsonValue, tool = "Shell"): string {
  const group: ModelHistoryGroup = {
    messageId: 1,
    generation: 1,
    runId: "run",
    createdAt: 1,
    records: [{ kind: "result", payload: { callId: "call", tool, outcome: "completed", output, media: [], resources: [] } }],
    metadata: null,
    compatibility: {
      text: renderToolResultOutput(output),
      media: [],
      mediaJson: null,
      hasMedia: false,
      isError: false,
      legacyImageContent: null,
    },
  };
  const message = renderModelHistoryGroup(group);
  if (message?.role !== "toolResult") throw new Error("Expected a tool result");
  const [content] = message.content;
  if (content?.type !== "text") throw new Error("Expected text");
  return content.text;
}
