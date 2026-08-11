import { describe, expect, it } from "vitest";
import {
  activityCategoryForSyscall,
  normalizeActivitySummary,
  recordCompletedActivity,
} from "./activity";

describe("process activity", () => {
  it("maps the fixed model tool surface to consumer activity categories", () => {
    expect(activityCategoryForSyscall("fs.search")).toBe("searching_files");
    expect(activityCategoryForSyscall("fs.read")).toBe("reading_files");
    expect(activityCategoryForSyscall("fs.write")).toBe("writing_files");
    expect(activityCategoryForSyscall("fs.edit")).toBe("editing_files");
    expect(activityCategoryForSyscall("fs.delete")).toBe("deleting_files");
    expect(activityCategoryForSyscall("shell.exec")).toBe("running_commands");
    expect(activityCategoryForSyscall("codemode.exec")).toBe("running_code");
    expect(activityCategoryForSyscall("net.fetch")).toBeNull();
  });

  it("counts only completed operations in stable category order", () => {
    let summary = recordCompletedActivity(undefined, "shell.exec", "completed");
    summary = recordCompletedActivity(summary, "fs.read", "completed");
    summary = recordCompletedActivity(summary, "fs.read", "completed");
    summary = recordCompletedActivity(summary, "fs.search", "failed");
    summary = recordCompletedActivity(summary, "fs.write", "cancelled");
    summary = recordCompletedActivity(summary, "fs.edit", "denied");
    summary = recordCompletedActivity(summary, "unknown", "completed");

    expect(summary).toEqual([
      { category: "reading_files", count: 2, unit: "reads" },
      { category: "running_commands", count: 1, unit: "commands" },
    ]);
  });

  it("normalizes old or hostile metadata without retaining payload fields", () => {
    const secret = "/home/hank/private.txt";
    expect(normalizeActivitySummary(undefined)).toBeNull();
    expect(normalizeActivitySummary([
      {
        category: "reading_files",
        count: 1,
        unit: "reads",
        path: secret,
        args: { token: "do-not-store" },
      },
      { category: "reading_files", count: 2, unit: "reads" },
      { category: "writing_files", count: 1, unit: "files" },
      { category: "thinking", count: 8, unit: "operations" },
      { category: "running_code", count: -1, unit: "runs" },
    ])).toEqual([
      { category: "reading_files", count: 3, unit: "reads" },
    ]);

    const serialized = JSON.stringify(normalizeActivitySummary([{
      category: "reading_files",
      count: 1,
      unit: "reads",
      path: secret,
    }]));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("path");
  });
});
