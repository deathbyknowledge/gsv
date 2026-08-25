import { describe, expect, it } from "vitest";
import type { WorkspaceRecord, WorkspaceStore } from "../../kernel/workspaces";
import type { ProcessIdentity } from "../../syscalls/system";
import { createWorkspaceBackend } from "./workspace";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/workspaces/ws_demo",
  workspaceId: "ws_demo",
};

const WORKSPACE: WorkspaceRecord = {
  workspaceId: "ws_demo",
  ownerUid: 1000,
  label: "Demo",
  kind: "thread",
  state: "active",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  defaultBranch: "main",
  headCommit: null,
  metaJson: null,
};

function makeWorkspaceStore(): WorkspaceStore {
  return {
    get(workspaceId: string): WorkspaceRecord | null {
      return workspaceId === WORKSPACE.workspaceId ? WORKSPACE : null;
    },
    list(): WorkspaceRecord[] {
      return [WORKSPACE];
    },
  } as WorkspaceStore;
}

function makeFetcher(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): Fetcher {
  return {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
      return Promise.resolve(handler(url, init));
    },
  } as Fetcher;
}

describe("WorkspaceMountBackend.history", () => {
  it("maps ripgit history entries into workspace paths", async () => {
    const backend = createWorkspaceBackend(
      {
        RIPGIT: makeFetcher((url) => {
          expect(url.pathname).toBe("/hyperspace/repos/uid-1000/ws_demo/history");
          expect(url.searchParams.get("path")).toBe("src");
          expect(url.searchParams.get("limit")).toBe("6");
          return Response.json({
            ok: true,
            entries: [
              {
                commit: "abcdef1234567890",
                author: "sam",
                timestamp: 1_710_000_000,
                message: "add workspace history panel",
                changes: [
                  { path: "src/fs/history.ts", kind: "modified" },
                  { path: "README.md", kind: "modified" },
                ],
              },
            ],
          });
        }),
        RIPGIT_INTERNAL_KEY: "secret-key",
      } as Env,
      IDENTITY,
      makeWorkspaceStore(),
    );

    const result = await backend?.history?.("/workspaces/ws_demo/src", 6);

    expect(result).toEqual({
      entries: [
        {
          commit: "abcdef1234567890",
          author: "sam",
          timestamp: 1_710_000_000_000,
          message: "add workspace history panel",
          changes: [
            {
              path: "/workspaces/ws_demo/src/fs/history.ts",
              previousPath: null,
              kind: "modified",
            },
          ],
        },
      ],
      truncated: undefined,
    });
  });
});
