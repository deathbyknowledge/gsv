import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { bodyFromText } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { listInstructions, readInstruction, saveInstruction } from "./settingsService";

const client = { call: vi.fn<GSVClient["call"]>(), request: vi.fn<GSVClient["request"]>() };

beforeEach(() => { vi.resetAllMocks(); });

describe("Settings instruction storage", () => {
  it("lists existing Markdown files without eagerly reading them", async () => {
    client.request.mockResolvedValueOnce({ data: { ok: true, path: "/home/viewer/context.d", files: ["z.md", "notes.txt", "a.md"], directories: ["nested"] } });
    expect(await listInstructions(client)).toEqual(["a.md", "z.md"]);
    expect(client.request).toHaveBeenCalledExactlyOnceWith("fs.read", { target: "gsv", path: "~/context.d" });
  });

  it("preserves exact instruction bytes, including blank content and leading numbered tabs", async () => {
    const writeArgs = z.strictObject({ path: z.string(), content: z.string() });
    client.call.mockImplementation(async (method, args) => {
      expect(method).toBe("fs.write");
      const input = writeArgs.parse(args);
      return { ok: true, path: input.path, size: input.content.length };
    });
    for (const content of ["", "1\tliteral numbered text\r\n\n"]) {
      client.request.mockResolvedValueOnce({ data: { ok: true, path: "/home/viewer/context.d/a.md", kind: "text", contentType: "text/markdown", size: content.length }, body: bodyFromText(content) });
      expect(await readInstruction(client, "a.md")).toBe(content);
      await saveInstruction(client, "a.md", content);
      expect(client.call).toHaveBeenLastCalledWith("fs.write", { path: "~/context.d/a.md", content });
    }
  });

  it("reports directory, file, and write failures instead of presenting empty or saved instructions", async () => {
    client.request.mockResolvedValueOnce({ data: { ok: false, error: "Permission denied" } });
    await expect(listInstructions(client)).rejects.toThrow("Permission denied");
    client.request.mockResolvedValueOnce({ data: { ok: false, error: "File unavailable" } });
    await expect(readInstruction(client, "a.md")).rejects.toThrow("File unavailable");
    client.call.mockResolvedValueOnce({ ok: false, error: "Read-only filesystem" });
    await expect(saveInstruction(client, "a.md", "")).rejects.toThrow("Read-only filesystem");
  });

  it("does not turn non-text or partial reads into editable content", async () => {
    client.request.mockResolvedValueOnce({ data: { ok: true, path: "/home/viewer/context.d/a.md", kind: "file", contentType: "application/octet-stream", size: 32 } });
    await expect(readInstruction(client, "a.md")).rejects.toThrow("not readable text");
    client.request.mockResolvedValueOnce({ data: { ok: true, path: "/home/viewer/context.d/a.md", kind: "text", contentType: "text/markdown", size: 100, truncated: true }, body: bodyFromText("partial") });
    await expect(readInstruction(client, "a.md")).rejects.toThrow("without losing content");
    expect(client.call).not.toHaveBeenCalled();
  });

  it("rejects an out-of-folder file before issuing any request", async () => {
    await expect(readInstruction(client, "../private.md")).rejects.toThrow();
    await expect(saveInstruction(client, "../private.md", "replacement")).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });

  it("requires a valid write receipt before claiming a save succeeded", async () => {
    client.call.mockResolvedValueOnce({ message: "unexpected reply" });
    await expect(saveInstruction(client, "a.md", "")).rejects.toThrow();
  });
});
