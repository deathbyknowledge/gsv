import type { ToolDefinition } from ".";
import { WEB_SEARCH, SYSCALL_TOOL_NAMES } from "./constants";

export const WEB_SEARCH_DEFINITION: ToolDefinition = {
  name: SYSCALL_TOOL_NAMES[WEB_SEARCH],
  description:
    "Search the web for current information and sources. Returns titles, URLs, and excerpts, not full pages. Use Shell commands or CodeMode fs.search for file contents.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Web search query",
        minLength: 1,
        maxLength: 2000,
      },
      limit: {
        type: "integer",
        description: "Maximum number of results (defaults to 5)",
        minimum: 1,
        maximum: 10,
      },
      includeDomains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Only search these hostnames, such as example.com",
      },
      excludeDomains: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Exclude these hostnames",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export type {
  FsSearchArgs,
  FsSearchMatch,
  FsSearchResult,
} from "@humansandmachines/gsv/protocol";
