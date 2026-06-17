import type { ArgsOf, ResultOf, SyscallName } from "./protocol/syscalls/map";

export type GsvClientCall = {
  <S extends SyscallName>(call: S, args: ArgsOf<S>): Promise<ResultOf<S>>;
  <T = unknown>(call: string, args?: unknown): Promise<T>;
};

export type GsvClientTransport = {
  call: GsvClientCall;
};

export type GsvAccountNamespace = {
  create: (args: ArgsOf<"account.create">) => Promise<ResultOf<"account.create">>;
  list: (args?: ArgsOf<"account.list">) => Promise<ResultOf<"account.list">>;
};

export type GsvFsNamespace = {
  copy: (args: ArgsOf<"fs.copy">) => Promise<ResultOf<"fs.copy">>;
};

export type GsvPkgNamespace = {
  create: (args: ArgsOf<"pkg.create">) => Promise<ResultOf<"pkg.create">>;
};

export type GsvProcNamespace = {
  spawn: (args: ArgsOf<"proc.spawn">) => Promise<ResultOf<"proc.spawn">>;
  send: (args: ArgsOf<"proc.send">) => Promise<ResultOf<"proc.send">>;
  history: (args?: ArgsOf<"proc.history">) => Promise<ResultOf<"proc.history">>;
  media: {
    read: (args: ArgsOf<"proc.media.read">) => Promise<ResultOf<"proc.media.read">>;
  };
  conversation: {
    timeline: (args?: ArgsOf<"proc.conversation.timeline">) =>
      Promise<ResultOf<"proc.conversation.timeline">>;
    generations: (args?: ArgsOf<"proc.conversation.generations">) =>
      Promise<ResultOf<"proc.conversation.generations">>;
    generation: {
      manifest: (args: ArgsOf<"proc.conversation.generation.manifest">) =>
        Promise<ResultOf<"proc.conversation.generation.manifest">>;
    };
  };
};

export type GsvClient = {
  call: GsvClientCall;
  account: GsvAccountNamespace;
  fs: GsvFsNamespace;
  pkg: GsvPkgNamespace;
  proc: GsvProcNamespace;
};

type GsvClientNamespaces = Omit<GsvClient, "call">;

function createNamespaces(call: GsvClientCall): GsvClientNamespaces {
  return {
    account: {
      create: (args) => call("account.create", args),
      list: (args = {}) => call("account.list", args),
    },
    fs: {
      copy: (args) => call("fs.copy", args),
    },
    pkg: {
      create: (args) => call("pkg.create", args),
    },
    proc: {
      spawn: (args) => call("proc.spawn", args),
      send: (args) => call("proc.send", args),
      history: (args = {}) => call("proc.history", args),
      media: {
        read: (args) => call("proc.media.read", args),
      },
      conversation: {
        timeline: (args = {}) => call("proc.conversation.timeline", args),
        generations: (args = {}) => call("proc.conversation.generations", args),
        generation: {
          manifest: (args) => call("proc.conversation.generation.manifest", args),
        },
      },
    },
  };
}

export class GSVClient implements GsvClient {
  readonly call: GsvClientCall;
  readonly account: GsvAccountNamespace;
  readonly fs: GsvFsNamespace;
  readonly pkg: GsvPkgNamespace;
  readonly proc: GsvProcNamespace;

  constructor(transport: GsvClientTransport) {
    this.call = ((syscall: string, args?: unknown) => transport.call(syscall, args)) as GsvClientCall;
    const namespaces = createNamespaces(this.call);
    this.account = namespaces.account;
    this.fs = namespaces.fs;
    this.pkg = namespaces.pkg;
    this.proc = namespaces.proc;
  }
}

export function createGsvClient(transport: GsvClientTransport): GsvClient {
  return new GSVClient(transport);
}
