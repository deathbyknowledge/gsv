import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import type { RequestFrame, ResponseFrame } from "../../../protocol/frames";
import { buildAccountCommand } from "./account";

const USER: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

describe("account shell command", () => {
  it("creates an owned agent through account.create", async () => {
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => {
      expect(frame.call).toBe("account.create");
      expect(frame.args).toEqual({
        kind: "agent",
        username: "scout",
        gecos: "Research Bot",
        persona: "Be precise.",
      });
      return ok(frame, {
        kind: "agent",
        account: { ...USER, uid: 1001, gid: 1001, username: "scout", home: "/home/scout", cwd: "/home/scout" },
      });
    });

    const result = await run(
      ["create", "scout", "--gecos", "Research Bot", "--persona", "Be precise."],
      ["account.create"],
      request,
    );

    expect(result).toEqual({
      stdout: "kind=agent username=scout uid=1001\n",
      stderr: "",
      exitCode: 0,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("creates a human with a stdin password without echoing it", async () => {
    const password = "correct horse battery staple";
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => {
      expect(frame.call).toBe("account.create");
      expect(frame.args).toEqual({
        kind: "human",
        username: "bob",
        password,
        gecos: "Bob Example",
      });
      return ok(frame, {
        kind: "human",
        account: { ...USER, uid: 1002, gid: 1002, username: "bob", home: "/home/bob", cwd: "/home/bob" },
        personalAgent: { ...USER, uid: 1003, gid: 1003, username: "juno", home: "/home/juno", cwd: "/home/juno" },
      });
    });

    const result = await run(
      ["create", "bob", "--kind", "human", "--password-stdin", "--gecos", "Bob Example"],
      ["account.create"],
      request,
      `${password}\n`,
      { ...USER, uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "kind=human username=bob uid=1002 personal_agent=juno personal_agent_uid=1003\n",
    );
    expect(result.stdout).not.toContain(password);
    expect(result.stderr).not.toContain(password);
  });

  it("lists and resolves accounts through their public syscalls", async () => {
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => {
      if (frame.call === "account.list") {
        expect(frame.args).toEqual({ uid: 1000 });
        return ok(frame, {
          accounts: [{
            uid: 1000,
            username: "sam",
            displayName: "Sam\tExample",
            relation: "self",
            runnable: true,
          }],
        });
      }
      expect(frame.call).toBe("account.get");
      expect(frame.args).toEqual({ uid: 1000 });
      return ok(frame, {
        account: {
          uid: 1000,
          username: "sam",
          gid: 1000,
          gids: [1000, 100],
          home: "/home/sam",
          shell: "/bin/init",
          kind: "human",
          state: "active",
          displayName: "Sam Example",
          capabilities: ["shell.exec"],
          delegable: false,
        },
      });
    });

    const listed = await run(
      ["list", "--uid", "1000"],
      ["account.list"],
      request,
    );
    const resolved = await run(
      ["get", "1000"],
      ["account.get"],
      request,
    );

    expect(listed.stdout).toBe(
      "UID\tUSERNAME\tRELATION\tNAME\n1000\tsam\tself\tSam Example\n",
    );
    expect(resolved.stdout).toBe(
      "USERNAME\tUID\tGID\tKIND\tSTATE\tHOME\tSHELL\tDELEGABLE\nsam\t1000\t1000\thuman\tactive\t/home/sam\t/bin/init\tno\n",
    );
  });

  it("lists visible capability records in a stable order", async () => {
    const request = vi.fn(async (frame: RequestFrame): Promise<ResponseFrame> => {
      expect(frame.call).toBe("sys.cap.list");
      expect(frame.args).toEqual({ gid: 1000 });
      return ok(frame, {
        records: [
          { gid: 1000, capability: "shell.exec" },
          { gid: 1000, capability: "account.get" },
        ],
      });
    });

    const result = await run(
      ["caps", "--gid", "1000"],
      ["sys.cap.list"],
      request,
    );

    expect(result.stdout).toBe(
      "GID\tCAPABILITY\n1000\taccount.get\n1000\tshell.exec\n",
    );
  });

  it("checks command capabilities before issuing a syscall", async () => {
    const request = vi.fn();

    const result = await run(["list"], [], request);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("account: Permission denied: account.list\n");
    expect(request).not.toHaveBeenCalled();
  });
});

async function run(
  args: string[],
  capabilities: string[],
  request: (frame: RequestFrame, signal?: AbortSignal) => Promise<ResponseFrame>,
  stdin = "",
  identity = USER,
) {
  const command = buildAccountCommand({
    identity: {
      role: "user",
      process: identity,
      capabilities,
    },
  } as KernelContext, request);
  return command.execute(args, {
    stdin,
    signal: new AbortController().signal,
  } as CommandContext);
}

function ok(frame: RequestFrame, data: unknown): ResponseFrame {
  return {
    type: "res",
    id: frame.id,
    ok: true,
    data,
  } as ResponseFrame;
}
