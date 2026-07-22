import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "just-bash";
import type {
  ProcessIdentity,
  UserAdminCreateResult,
  UserAdminPermissionsResult,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import type { RequestFrame, ResponseFrame } from "../../../protocol/frames";
import { buildUserCommand } from "./user";

const ACCOUNT: ProcessIdentity = {
  uid: 1002,
  gid: 1002,
  gids: [1002, 100],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
};

const PERSONAL_AGENT: ProcessIdentity = {
  uid: 1003,
  gid: 1003,
  gids: [1003, 1002, 100],
  username: "friday",
  home: "/home/friday",
  cwd: "/home/friday",
};

const CREATE_RESULT: UserAdminCreateResult = {
  action: "create",
  account: ACCOUNT,
  personalAgent: PERSONAL_AGENT,
};

const PERMISSIONS_RESULT: UserAdminPermissionsResult = {
  action: "permissions",
  user: { username: "alice", uid: 1002, gid: 1002 },
  groups: [
    { name: "alice", gid: 1002, primary: true },
    { name: "operators", gid: 1200, primary: false },
  ],
  directCapabilities: ["repo.create"],
  effectiveCapabilities: ["fs.read", "repo.create"],
  changed: true,
};

describe("native user command", () => {
  it("creates a human through user.admin with a password read from stdin", async () => {
    const request = successfulRequest(CREATE_RESULT);
    const result = await execute(
      ["create", "alice", "--password-stdin"],
      "  correct horse  \n",
      request,
    );

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      call: "user.admin",
      args: {
        action: "create",
        username: "alice",
        password: "  correct horse  ",
      },
    }), undefined);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Created human account alice (uid 1002, gid 1002).");
    expect(result.stdout).toContain("Personal agent: friday (uid 1003, gid 1003)");
    expect(result.stdout).not.toContain("correct horse");
  });

  it("registers through the same create action and requires a fresh login", async () => {
    const request = successfulRequest(CREATE_RESULT);
    const result = await execute(
      ["register", "alice", "--password-stdin"],
      "password-123",
      request,
    );

    expect(request.mock.calls[0][0]).toMatchObject({
      call: "user.admin",
      args: { action: "create", username: "alice", password: "password-123" },
    });
    expect(result.stdout).toContain("Registration complete. Start a new login as alice.");
  });

  it("maps permission views and repeated edits to one atomic patch request", async () => {
    const request = successfulRequest(PERMISSIONS_RESULT);
    const edited = await execute([
      "permissions",
      "alice",
      "--grant",
      "repo.create",
      "--grant",
      "repo.delete",
      "--revoke",
      "net.fetch",
      "--add-group",
      "operators",
      "--remove-group",
      "guests",
    ], "", request);
    await execute(["permissions", "alice"], "", request);

    expect(request.mock.calls[0][0]).toMatchObject({
      call: "user.admin",
      args: {
        action: "permissions",
        username: "alice",
        grant: ["repo.create", "repo.delete"],
        revoke: ["net.fetch"],
        addGroups: ["operators"],
        removeGroups: ["guests"],
      },
    });
    expect(request.mock.calls[1][0]).toMatchObject({
      args: { action: "permissions", username: "alice" },
    });
    expect(request.mock.calls[1][0].args).not.toHaveProperty("grant");
    expect(edited.stdout).toContain("Direct capabilities:\n  repo.create");
    expect(edited.stdout).toContain("Permissions updated.");
  });

  it("denies a regular user before sending any administration request", async () => {
    const request = successfulRequest(CREATE_RESULT);
    const result = await execute(
      ["create", "alice", "--password-stdin"],
      "password-123",
      request,
      ["shell.exec"],
    );

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toBe("user: Permission denied: user.admin\n");
    expect(request).not.toHaveBeenCalled();
  });

  it("denies inherited or stale administration before materializing a request", async () => {
    for (const ctx of [
      kernelContext(["shell.exec", "user.admin"], { directlyGranted: false }),
      kernelContext(["shell.exec", "user.admin"], {
        directlyGranted: false,
        identity: PERSONAL_AGENT,
      }),
    ]) {
      const request = successfulRequest(CREATE_RESULT);
      const result = await buildUserCommand(ctx, request).execute(
        ["create", "alice", "--password-stdin"],
        commandContext("password-123"),
      );

      expect(result.stderr).toBe("user: Permission denied\n");
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("propagates the durable authority denial from nested syscall dispatch", async () => {
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => ({
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 403, message: "Permission denied" },
    }));
    const result = await execute(
      ["permissions", "alice", "--grant", "repo.create"],
      "",
      request,
    );

    expect(result.stderr).toBe("user: Permission denied\n");
    expect(request).toHaveBeenCalledOnce();
  });

  it("shows help without administration authority or syscall transport", async () => {
    const command = buildUserCommand(kernelContext(["shell.exec"]));
    const result = await command.execute(["--help"], commandContext(""));

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("user create USER --password-stdin");
  });
});

function successfulRequest(result: UserAdminCreateResult | UserAdminPermissionsResult) {
  return vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => ({
    type: "res",
    id: frame.id,
    ok: true,
    data: result,
  } as ResponseFrame));
}

async function execute(
  args: string[],
  stdin: string,
  request: (frame: RequestFrame, signal?: AbortSignal) => Promise<ResponseFrame>,
  capabilities = ["shell.exec", "user.admin"],
) {
  return await buildUserCommand(kernelContext(capabilities), request)
    .execute(args, commandContext(stdin));
}

function kernelContext(
  capabilities: string[],
  options?: { directlyGranted?: boolean; identity?: ProcessIdentity },
): KernelContext {
  const identity = options?.identity ?? {
    uid: 1000,
    gid: 1000,
    gids: [1000, 100],
    username: "root-admin",
    home: "/home/root-admin",
    cwd: "/home/root-admin",
  };
  const directlyGranted = options?.directlyGranted ?? capabilities.includes("user.admin");
  return {
    auth: {
      getPasswdByUid: vi.fn((uid: number) => uid === identity.uid
        ? {
          username: identity.username,
          uid: identity.uid,
          gid: identity.gid,
          gecos: identity.username,
          home: identity.home,
          shell: "/bin/init",
        }
        : null),
    },
    caps: {
      list: vi.fn((gid?: number) => directlyGranted && gid === identity.gid
        ? [{ gid: identity.gid, capability: "user.admin" }]
        : []),
    },
    identity: {
      role: "user",
      process: identity,
      capabilities,
    },
  } as KernelContext;
}

function commandContext(stdin: string): CommandContext {
  return {
    fs: {} as CommandContext["fs"],
    cwd: "/home/root-admin",
    env: new Map(),
    stdin,
  };
}
