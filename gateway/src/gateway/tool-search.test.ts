import { describe, expect, it } from "vitest";
import { tokenize, scoreToolMatch } from "./tool-search";

describe("tool search", () => {
  describe("tokenize", () => {
    it("splits on spaces", () => {
      expect(tokenize("react hooks")).toEqual(["react", "hooks"]);
    });

    it("expands camelCase", () => {
      expect(tokenize("useEffect")).toEqual(["use", "effect"]);
    });

    it("normalizes separators", () => {
      expect(tokenize("query-docs")).toEqual(["query", "docs"]);
      expect(tokenize("resolve_library_id")).toEqual(["resolve", "library", "id"]);
    });
  });

  describe("scoreToolMatch", () => {
    const docsTool = {
      name: "context7__query-docs",
      description: "Retrieves and queries up-to-date documentation and code examples from Context7",
      inputSchema: {
        type: "object",
        properties: { libraryId: {}, query: {} },
      },
    };

    const resolveTool = {
      name: "context7__resolve-library-id",
      description: "Resolves a package/product name to a Context7-compatible library ID",
      inputSchema: {
        type: "object",
        properties: { libraryName: {}, query: {} },
      },
    };

    const readFile = {
      name: "gsv__ReadFile",
      description: "Read a file or list a directory in your workspace.",
      inputSchema: {
        type: "object",
        properties: { path: {} },
      },
    };

    it("scores documentation query higher for docs tool", () => {
      const tokens = tokenize("documentation");
      const docsScore = scoreToolMatch(tokens, docsTool);
      const resolveScore = scoreToolMatch(tokens, resolveTool);
      const readScore = scoreToolMatch(tokens, readFile);

      expect(docsScore).toBeGreaterThan(resolveScore);
      expect(docsScore).toBeGreaterThan(readScore);
    });

    it("scores 'react docs' matching both tokens", () => {
      const tokens = tokenize("react docs");
      const docsScore = scoreToolMatch(tokens, docsTool);
      // "docs" matches tool name, no exact "react" but partial coverage
      expect(docsScore).toBeGreaterThan(0);
    });

    it("scores source ID matches (context7)", () => {
      const tokens = tokenize("context7");
      const docsScore = scoreToolMatch(tokens, docsTool);
      const readScore = scoreToolMatch(tokens, readFile);

      expect(docsScore).toBeGreaterThan(0);
      expect(readScore).toBe(0);
    });

    it("returns 0 for no match", () => {
      const tokens = tokenize("kubernetes");
      expect(scoreToolMatch(tokens, docsTool)).toBe(0);
      expect(scoreToolMatch(tokens, readFile)).toBe(0);
    });

    it("scores file-related query higher for ReadFile", () => {
      const tokens = tokenize("read file");
      const readScore = scoreToolMatch(tokens, readFile);
      const docsScore = scoreToolMatch(tokens, docsTool);

      expect(readScore).toBeGreaterThan(docsScore);
    });
  });
});
