export type PrincipalProfile = {
  homeSpaceId: string;
  homeAgentId?: string;
  status?: "bound" | "allowed_unbound";
  createdAt: number;
  updatedAt: number;
};

export type SpaceMember = {
  role: string;
  joinedAt: number;
  updatedAt: number;
};

export type GroupMode = "group-shared" | "per-user-in-group" | "hybrid";

export type ThreadMode =
  | "group-shared"
  | "per-user-in-group"
  | "per-user"
  | "hybrid";

export type ConversationBinding = {
  spaceId: string;
  agentId?: string;
  groupMode?: GroupMode;
  createdAt: number;
  updatedAt: number;
};

export type InviteStatus = "active" | "claimed" | "revoked" | "expired";

export type InviteRecord = {
  inviteId: string;
  code: string;
  homeSpaceId: string;
  homeAgentId?: string;
  role: string;
  principalId?: string;
  status: InviteStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  claimedAt?: number;
  claimedBy?: string;
  revokedAt?: number;
};

export type InviteClaimResult =
  | { ok: true; invite: InviteRecord }
  | {
    ok: false;
    reason:
      | "not-found"
      | "expired"
      | "revoked"
      | "already-claimed"
      | "principal-mismatch";
  };

export type RouteTupleV1 = {
  v: 1;
  spaceId: string;
  agentId: string;
  surfaceId: string;
  threadMode: ThreadMode | (string & {});
  actorId?: string;
};

export type StoredThreadRoute = {
  threadId: string;
  routeTuple: {
    v: 1;
    spaceId: string;
    agentId: string;
    threadMode: string;
    hasActor: boolean;
    surfaceHash: string;
  };
  createdAt: number;
};

export type ThreadMeta = {
  stateId: string;
  spaceId: string;
  agentId: string;
  createdAt: number;
  lastActiveAt: number;
  legacy: boolean;
  legacySessionKey?: string;
};

export interface RegistryStore {
  getPrincipalProfile(principalId: string): PrincipalProfile | undefined;
  listPrincipalProfiles(): Record<string, PrincipalProfile>;
  upsertPrincipalProfile(
    principalId: string,
    value: Omit<PrincipalProfile, "createdAt" | "updatedAt">,
  ): PrincipalProfile;
  deletePrincipalProfile(principalId: string): boolean;
  getConversationBinding(surfaceId: string): ConversationBinding | undefined;
  listConversationBindings(): Record<string, ConversationBinding>;
  upsertConversationBinding(
    surfaceId: string,
    value: Omit<ConversationBinding, "createdAt" | "updatedAt">,
  ): ConversationBinding;
  removeConversationBinding(surfaceId: string): boolean;
  isMember(spaceId: string, principalId: string): boolean;
  listSpaceMembers(): Record<string, Record<string, SpaceMember>>;
  getSpaceMembers(spaceId: string): Record<string, SpaceMember>;
  ensureMember(spaceId: string, principalId: string, role: string): SpaceMember;
  setMember(spaceId: string, principalId: string, role: string): SpaceMember;
  removeMember(spaceId: string, principalId: string): boolean;
  isOwner(principalId: string): boolean;
  getThreadRoute(routeHash: string): StoredThreadRoute | undefined;
  putThreadRoute(routeHash: string, route: StoredThreadRoute): void;
  getThreadMeta(threadId: string): ThreadMeta | undefined;
  putThreadMeta(threadId: string, meta: ThreadMeta): void;
  touchThreadMeta(threadId: string, timestamp?: number): void;
  getLegacyThreadId(sessionKey: string): string | undefined;
  putLegacyThreadId(sessionKey: string, threadId: string): void;
  listInvites(): Record<string, InviteRecord>;
  createInvite(input: {
    code: string;
    homeSpaceId: string;
    homeAgentId?: string;
    role: string;
    principalId?: string;
    expiresAt?: number;
  }): InviteRecord;
  revokeInvite(inviteId: string): InviteRecord | undefined;
  claimInvite(code: string, principalId: string): InviteClaimResult;
}

type RegistryMaps = {
  principalProfiles: Record<string, PrincipalProfile>;
  spaceMembers: Record<string, Record<string, SpaceMember>>;
  conversationBindings: Record<string, ConversationBinding>;
  threadRoutes: Record<string, StoredThreadRoute>;
  threadMeta: Record<string, ThreadMeta>;
  legacyThreadIndex: Record<string, string>;
  invites: Record<string, InviteRecord>;
};

export class GatewayRegistryStore implements RegistryStore {
  constructor(private readonly maps: RegistryMaps) {}

  getPrincipalProfile(principalId: string): PrincipalProfile | undefined {
    return this.maps.principalProfiles[principalId];
  }

  listPrincipalProfiles(): Record<string, PrincipalProfile> {
    return this.maps.principalProfiles;
  }

  upsertPrincipalProfile(
    principalId: string,
    value: Omit<PrincipalProfile, "createdAt" | "updatedAt">,
  ): PrincipalProfile {
    const now = Date.now();
    const existing = this.maps.principalProfiles[principalId];
    const next: PrincipalProfile = {
      ...value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.maps.principalProfiles[principalId] = next;
    return next;
  }

  deletePrincipalProfile(principalId: string): boolean {
    if (!(principalId in this.maps.principalProfiles)) {
      return false;
    }
    delete this.maps.principalProfiles[principalId];
    return true;
  }

  getConversationBinding(surfaceId: string): ConversationBinding | undefined {
    return this.maps.conversationBindings[surfaceId];
  }

  listConversationBindings(): Record<string, ConversationBinding> {
    return this.maps.conversationBindings;
  }

  upsertConversationBinding(
    surfaceId: string,
    value: Omit<ConversationBinding, "createdAt" | "updatedAt">,
  ): ConversationBinding {
    const now = Date.now();
    const existing = this.maps.conversationBindings[surfaceId];
    const next: ConversationBinding = {
      ...value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.maps.conversationBindings[surfaceId] = next;
    return next;
  }

  removeConversationBinding(surfaceId: string): boolean {
    if (!(surfaceId in this.maps.conversationBindings)) {
      return false;
    }
    delete this.maps.conversationBindings[surfaceId];
    return true;
  }

  isMember(spaceId: string, principalId: string): boolean {
    return Boolean(this.maps.spaceMembers[spaceId]?.[principalId]);
  }

  listSpaceMembers(): Record<string, Record<string, SpaceMember>> {
    return this.maps.spaceMembers;
  }

  getSpaceMembers(spaceId: string): Record<string, SpaceMember> {
    return this.maps.spaceMembers[spaceId] ?? {};
  }

  ensureMember(spaceId: string, principalId: string, role: string): SpaceMember {
    const now = Date.now();
    const members = this.maps.spaceMembers[spaceId] ?? {};
    const existing = members[principalId];
    const next: SpaceMember = {
      role: existing?.role ?? role,
      joinedAt: existing?.joinedAt ?? now,
      updatedAt: now,
    };
    members[principalId] = next;
    this.maps.spaceMembers[spaceId] = members;
    return next;
  }

  setMember(spaceId: string, principalId: string, role: string): SpaceMember {
    const now = Date.now();
    const members = this.maps.spaceMembers[spaceId] ?? {};
    const existing = members[principalId];
    const next: SpaceMember = {
      role,
      joinedAt: existing?.joinedAt ?? now,
      updatedAt: now,
    };
    members[principalId] = next;
    this.maps.spaceMembers[spaceId] = members;
    return next;
  }

  removeMember(spaceId: string, principalId: string): boolean {
    const members = this.maps.spaceMembers[spaceId];
    if (!members || !(principalId in members)) {
      return false;
    }
    delete members[principalId];
    if (Object.keys(members).length === 0) {
      delete this.maps.spaceMembers[spaceId];
    } else {
      this.maps.spaceMembers[spaceId] = members;
    }
    return true;
  }

  isOwner(principalId: string): boolean {
    for (const members of Object.values(this.maps.spaceMembers)) {
      if (members[principalId]?.role === "owner") {
        return true;
      }
    }
    return false;
  }

  getThreadRoute(routeHash: string): StoredThreadRoute | undefined {
    return this.maps.threadRoutes[routeHash];
  }

  putThreadRoute(routeHash: string, route: StoredThreadRoute): void {
    this.maps.threadRoutes[routeHash] = route;
  }

  getThreadMeta(threadId: string): ThreadMeta | undefined {
    return this.maps.threadMeta[threadId];
  }

  putThreadMeta(threadId: string, meta: ThreadMeta): void {
    this.maps.threadMeta[threadId] = meta;
  }

  touchThreadMeta(threadId: string, timestamp: number = Date.now()): void {
    const current = this.maps.threadMeta[threadId];
    if (!current) {
      return;
    }
    this.maps.threadMeta[threadId] = {
      ...current,
      lastActiveAt: timestamp,
    };
  }

  getLegacyThreadId(sessionKey: string): string | undefined {
    return this.maps.legacyThreadIndex[sessionKey];
  }

  putLegacyThreadId(sessionKey: string, threadId: string): void {
    this.maps.legacyThreadIndex[sessionKey] = threadId;
  }

  listInvites(): Record<string, InviteRecord> {
    return this.maps.invites;
  }

  createInvite(input: {
    code: string;
    homeSpaceId: string;
    homeAgentId?: string;
    role: string;
    principalId?: string;
    expiresAt?: number;
  }): InviteRecord {
    const now = Date.now();
    const inviteId = crypto.randomUUID();
    const next: InviteRecord = {
      inviteId,
      code: input.code,
      homeSpaceId: input.homeSpaceId,
      homeAgentId: input.homeAgentId,
      role: input.role,
      principalId: input.principalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    this.maps.invites[inviteId] = next;
    return next;
  }

  revokeInvite(inviteId: string): InviteRecord | undefined {
    const existing = this.maps.invites[inviteId];
    if (!existing) {
      return undefined;
    }
    const now = Date.now();
    const next: InviteRecord = {
      ...existing,
      status: existing.status === "claimed" ? "claimed" : "revoked",
      revokedAt: existing.status === "claimed" ? existing.revokedAt : now,
      updatedAt: now,
    };
    this.maps.invites[inviteId] = next;
    return next;
  }

  claimInvite(code: string, principalId: string): InviteClaimResult {
    const now = Date.now();
    const match = Object.values(this.maps.invites).find((invite) =>
      invite.code === code
    );
    if (!match) {
      return { ok: false, reason: "not-found" };
    }

    if (match.status === "revoked") {
      return { ok: false, reason: "revoked" };
    }
    if (match.status === "claimed") {
      return { ok: false, reason: "already-claimed" };
    }

    if (match.expiresAt !== undefined && match.expiresAt <= now) {
      this.maps.invites[match.inviteId] = {
        ...match,
        status: "expired",
        updatedAt: now,
      };
      return { ok: false, reason: "expired" };
    }

    if (match.principalId && match.principalId !== principalId) {
      return { ok: false, reason: "principal-mismatch" };
    }

    const claimed: InviteRecord = {
      ...match,
      status: "claimed",
      claimedBy: principalId,
      claimedAt: now,
      updatedAt: now,
    };
    this.maps.invites[match.inviteId] = claimed;
    return { ok: true, invite: claimed };
  }
}
