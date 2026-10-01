import { describe, expect, it } from "vitest";
import { childPath, detectPathStyle, normalizePath, parentPath, resolvePath } from "./paths";

describe("remote target paths", () => {
  it("retains Windows drive roots and resolves another drive", () => {
    expect(detectPathStyle("C:\\Users\\Alice")).toBe("absolute");
    expect(normalizePath("C:\\")).toBe("C:/");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/")).toBe("C:/");
    expect(resolvePath("D:\\docs", "C:/Users/Alice")).toBe("D:/docs");
    expect(resolvePath("\\docs", "D:/Users/Alice")).toBe("D:/docs");
    expect(childPath("C:/", "日本語.txt")).toBe("C:/日本語.txt");
  });
  it("preserves UNC share roots without traversing above them", () => {
    expect(normalizePath("\\\\server\\share\\docs")).toBe("//server/share/docs");
    expect(parentPath("//server/share/docs")).toBe("//server/share/");
    expect(parentPath("//server/share/")).toBe("//server/share/");
    expect(resolvePath("../../other", "//server/share/docs")).toBe("//server/share/other");
  });
  it("accepts extended paths emitted by Rust canonicalize", () => {
    expect(normalizePath("\\\\?\\C:\\Users\\Alice")).toBe("C:/Users/Alice");
    expect(normalizePath("\\\\?\\UNC\\server\\share\\docs")).toBe("//server/share/docs");
  });
  it("keeps gateway and POSIX paths unchanged", () => {
    expect(normalizePath("/home/alice/../bob")).toBe("/home/bob");
    expect(parentPath("/")).toBe("/");
    expect(resolvePath("../docs", "home/alice")).toBe("home/docs");
    expect(resolvePath("/docs", "home/alice")).toBe("/docs");
    expect(childPath(".", "hello.txt")).toBe("hello.txt");
  });
});
