import type {
  AdapterSurface,
  ConnectedPeer,
  PeerGrant,
  PeerPrincipal,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { hasCapability } from "./capabilities";
import type { ConnectionIdentity } from "./identity";

export type PeerTransport =
  | { kind: "websocket"; connectionId: string }
  | { kind: "service-binding"; serviceId: string }
  | { kind: "process-rpc"; processId: string }
  | { kind: "kernel" };

export type PeerProvenance =
  | { kind: "credential"; method: "password" | "token" }
  | { kind: "service-binding"; serviceId: string }
  | {
      kind: "adapter-link";
      serviceId: string;
      accountId: string;
      actorId: string;
      surface: AdapterSurface;
    }
  | { kind: "process-registry"; processId: string }
  | { kind: "kernel" };

export type PeerContext = {
  installationId: string;
  peer: ConnectedPeer;
  identity: ConnectionIdentity;
  transport: PeerTransport;
  provenance: PeerProvenance;
};

export type ServicePeerProfile = {
  id: string;
  calls: readonly string[];
};

export function peerAllowsCall(peer: PeerContext, call: string): boolean {
  return hasCapability(peer.peer.grant.calls, call);
}

export function peerProvidesOperations(peer: ConnectedPeer): boolean {
  return peer.grant.implements.length > 0;
}

export function peerConnectionIdentity(peer: ConnectedPeer): ConnectionIdentity {
  switch (peer.principal.kind) {
    case "human":
      return {
        role: "user",
        process: peer.principal.account,
        capabilities: peer.grant.calls,
      };
    case "machine":
      return {
        role: "driver",
        process: peer.principal.account,
        capabilities: peer.grant.calls,
        device: peer.id,
        implements: peer.grant.implements,
      };
    case "service":
      return {
        role: "service",
        process: peer.principal.account,
        capabilities: peer.grant.calls,
        channel: peer.id,
      };
  }
}

export function connectedPeerContext(input: {
  installationId: string;
  peer: ConnectedPeer;
  credential: "password" | "token";
}): PeerContext {
  return {
    installationId: input.installationId,
    peer: input.peer,
    identity: peerConnectionIdentity(input.peer),
    transport: {
      kind: "websocket",
      connectionId: input.peer.sessionId,
    },
    provenance: { kind: "credential", method: input.credential },
  };
}

export function servicePeerContext(input: {
  installationId: string;
  profile: ServicePeerProfile;
  sessionId: string;
  identity: ConnectionIdentity;
}): PeerContext {
  const principal: PeerPrincipal = {
    kind: "service",
    account: input.identity.process,
  };
  const grant: PeerGrant = {
    calls: [...input.profile.calls],
    signals: [],
    implements: [],
  };
  return {
    installationId: input.installationId,
    peer: {
      id: input.profile.id,
      sessionId: input.sessionId,
      principal,
      grant,
    },
    identity: input.identity,
    transport: { kind: "service-binding", serviceId: input.profile.id },
    provenance: { kind: "service-binding", serviceId: input.profile.id },
  };
}

/** A Process DO acting as its run-as account; internal-only syscalls key off this provenance. */
export function processPeerContext(input: {
  installationId: string;
  processId: string;
  identity: ProcessIdentity;
  calls: readonly string[];
}): PeerContext {
  const calls = [...input.calls];
  return {
    installationId: input.installationId,
    peer: {
      id: `process:${input.processId}`,
      sessionId: `process:${input.processId}`,
      principal: { kind: "human", account: input.identity },
      grant: { calls, signals: [], implements: [] },
    },
    identity: { role: "user", process: input.identity, capabilities: calls },
    transport: { kind: "process-rpc", processId: input.processId },
    provenance: { kind: "process-registry", processId: input.processId },
  };
}

/** Kernel-originated work, such as a schedule, acting as a resolved account. */
export function kernelPeerContext(input: {
  installationId: string;
  identity: ProcessIdentity;
  calls: readonly string[];
}): PeerContext {
  const calls = [...input.calls];
  return {
    installationId: input.installationId,
    peer: {
      id: "kernel",
      sessionId: "kernel",
      principal: { kind: "human", account: input.identity },
      grant: { calls, signals: [], implements: [] },
    },
    identity: { role: "user", process: input.identity, capabilities: calls },
    transport: { kind: "kernel" },
    provenance: { kind: "kernel" },
  };
}

export function delegatedAdapterPeerContext(input: {
  installationId: string;
  serviceId: string;
  accountId: string;
  actorId: string;
  surface: AdapterSurface;
  sessionId: string;
  identity: ProcessIdentity;
  calls: readonly string[];
}): PeerContext {
  const calls = [...input.calls];
  const peer: ConnectedPeer = {
    id: `adapter:${input.serviceId}:${input.accountId}:${input.actorId}`,
    sessionId: input.sessionId,
    principal: {
      kind: "human",
      account: input.identity,
    },
    grant: {
      calls,
      signals: [],
      implements: [],
    },
  };
  return {
    installationId: input.installationId,
    peer,
    identity: {
      role: "user",
      process: input.identity,
      capabilities: calls,
    },
    transport: {
      kind: "service-binding",
      serviceId: input.serviceId,
    },
    provenance: {
      kind: "adapter-link",
      serviceId: input.serviceId,
      accountId: input.accountId,
      actorId: input.actorId,
      surface: input.surface,
    },
  };
}
