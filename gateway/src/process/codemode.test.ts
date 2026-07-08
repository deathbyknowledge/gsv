import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { buildCodeModeMcpTypeDeclarations } from "../codemode/mcp";
import {
  buildCodeModeMcpToolBindings,
  executeCodeMode,
} from "./codemode";

describe.sequential("CodeMode executor", () => {
  it("runs with the Worker Loader binding and exposes shell and fs wrappers", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const result = await executeCodeMode(
      env,
      `
        const shellResult = await shell("npm test", { target: "gsv", cwd: "/workspace" });
        const readResult = await fs.read({ target: "gsv", path: "/workspace/package.json" });
        return {
          shellStatus: shellResult.status,
          shellOutput: shellResult.output,
          fileContent: readResult.content,
        };
      `,
      async (call, args) => {
        calls.push({ call, args });
        if (call === "shell.exec") {
          return { status: "completed", output: "ok", exitCode: 0 };
        }
        if (call === "fs.read") {
          return { ok: true, path: String(args.path), content: "file" };
        }
        throw new Error(`unexpected call: ${call}`);
      },
    );

    expect(calls).toEqual([
      {
        call: "shell.exec",
        args: { target: "gsv", cwd: "/workspace", input: "npm test" },
      },
      {
        call: "fs.read",
        args: { target: "gsv", path: "/workspace/package.json" },
      },
    ]);
    expect(result).toEqual({
      status: "completed",
      result: {
        shellStatus: "completed",
        shellOutput: "ok",
        fileContent: "file",
      },
    });
  });

  it("routes sandboxed fetch through the host callback", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const result = await executeCodeMode(
      env,
      `
        const response = await fetch("https://example.test/index.html", {
          headers: { "x-test": "yes" },
        });
        return {
          status: response.status,
          url: response.url,
          header: response.headers.get("content-type"),
          body: await response.text(),
        };
      `,
      async (call, args) => {
        calls.push({ call, args });
        if (call === "net.fetch") {
          return {
            url: String(args.url),
            status: 200,
            statusText: "OK",
            headers: [["content-type", "text/plain"]],
            bodyBase64: btoa("gateway test assets"),
            redirected: false,
          };
        }
        throw new Error(`unexpected call: ${call}`);
      },
    );

    expect(calls).toEqual([
      {
        call: "net.fetch",
        args: {
          url: "https://example.test/index.html",
          method: "GET",
          headers: [["x-test", "yes"]],
        },
      },
    ]);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toMatchObject({
        status: 200,
        url: "https://example.test/index.html",
        header: "text/plain",
      });
      expect(String((result.result as { body?: unknown }).body)).toContain("gateway test assets");
    }
  });

  it("applies command defaults and exposes argv and args", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const result = await executeCodeMode(
      env,
      `
        const shellResult = await shell("pwd");
        const readResult = await fs.read({ path: "package.json" });
        return { shellResult, readResult, argv, args };
      `,
      async (call, args) => {
        calls.push({ call, args });
        if (call === "shell.exec") {
          return { status: "completed", output: "/workspace\n", exitCode: 0 };
        }
        if (call === "fs.read") {
          return { ok: true, path: String(args.path), content: "{}" };
        }
        throw new Error(`unexpected call: ${call}`);
      },
      {
        defaultTarget: "gsv",
        defaultCwd: "/workspace",
        argv: ["one", "two"],
        args: { mode: "check" },
      },
    );

    expect(calls).toEqual([
      {
        call: "shell.exec",
        args: { target: "gsv", cwd: "/workspace", input: "pwd" },
      },
      {
        call: "fs.read",
        args: { target: "gsv", path: "/workspace/package.json" },
      },
    ]);
    expect(result).toEqual({
      status: "completed",
      result: {
        shellResult: { status: "completed", output: "/workspace\n", exitCode: 0 },
        readResult: { ok: true, path: "/workspace/package.json", content: "{}" },
        argv: ["one", "two"],
        args: { mode: "check" },
      },
    });
  });

  it("exposes connected MCP tools as direct CodeMode functions", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const mcpToolBindings = buildCodeModeMcpToolBindings([
      {
        serverId: "server-1",
        uid: 1000,
        name: "Search",
        url: "https://mcp.example.com/mcp",
        transport: "auto",
        state: "ready",
        authUrl: null,
        error: null,
        instructions: null,
        capabilities: null,
        tools: [{
          name: "lookup-record",
          description: "Lookup a record",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
          outputSchema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
          },
        }],
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    const result = await executeCodeMode(
      env,
      `
        const shortResult = await lookup_record({ query: "gsv" });
        const qualifiedResult = await Search_lookup_record({ query: "gsv" });
        return { mcpTools, shortResult, qualifiedResult };
      `,
      async (call, args) => {
        calls.push({ call, args });
        if (call === "sys.mcp.call") {
          return { structuredContent: { title: "GSV" } };
        }
        throw new Error(`unexpected call: ${call}`);
      },
      { mcpToolBindings },
    );

    expect(calls).toEqual([
      {
        call: "sys.mcp.call",
        args: {
          serverId: "server-1",
          name: "lookup-record",
          arguments: { query: "gsv" },
        },
      },
      {
        call: "sys.mcp.call",
        args: {
          serverId: "server-1",
          name: "lookup-record",
          arguments: { query: "gsv" },
        },
      },
    ]);
    expect(result).toEqual({
      status: "completed",
      result: {
        mcpTools: [
          {
            functionName: "lookup_record",
            serverId: "server-1",
            serverName: "Search",
            toolName: "lookup-record",
            description: "Lookup a record",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
            outputSchema: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
              required: ["title"],
            },
          },
          {
            functionName: "Search_lookup_record",
            serverId: "server-1",
            serverName: "Search",
            toolName: "lookup-record",
            description: "Lookup a record",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
            outputSchema: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
              required: ["title"],
            },
          },
        ],
        shortResult: { title: "GSV" },
        qualifiedResult: { title: "GSV" },
      },
    });
  });

  it("generates TypeScript declarations for connected MCP functions", () => {
    const bindings = buildCodeModeMcpToolBindings([
      {
        serverId: "server-1",
        name: "Search",
        state: "ready",
        tools: [{
          name: "lookup-record",
          description: "Lookup a record",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
          outputSchema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
          },
        }],
      },
    ]);

    const declarations = buildCodeModeMcpTypeDeclarations(bindings);

    expect(declarations).toContain("type LookupRecordInput");
    expect(declarations).toContain("query: string");
    expect(declarations).toContain("type LookupRecordOutput");
    expect(declarations).toContain("title: string");
    expect(declarations).toContain("declare function lookup_record(input: LookupRecordInput): Promise<LookupRecordOutput>;");
    expect(declarations).toContain("declare function Search_lookup_record(input: SearchLookupRecordInput): Promise<SearchLookupRecordOutput>;");
  });
});
