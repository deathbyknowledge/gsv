import type { Kernel } from "../do";

/** Owns compensation for signup reservations whose caller never received a link. */
export class SignupInvitationCleanup {
  constructor(private readonly host: Kernel) {}

  enqueue(inviteId: string, dueAtMs = Date.now()): string {
    return this.host.tasks.enqueue(new Date(dueAtMs), {
      callback: "onSignupInvitationCleanup", payload: inviteId,
    }).id;
  }

  arm(): Promise<void> { return this.host.tasks.arm(); }

  complete(taskId: string): Promise<boolean> { return this.host.tasks.cancel(taskId); }

  async run(inviteId: string, taskId: string): Promise<void> {
    await this.host.federationRuntime.coordinateFederationContact(`invitation:${inviteId}`, async () => {
      // A successful reservation may have removed this task while it waited for the lock.
      if (!this.host.tasks.has(taskId)) return;
      const invite = this.host.federation.invite(inviteId);
      if (!invite || invite.state === "accepted" || invite.expiresAtMs <= Date.now()) return;
      if (invite.state === "issued") {
        this.host.federation.cancelInvite(inviteId, invite.ownerUid);
        this.host.connectionRuntime.broadcastToUserUid(invite.ownerUid, "contact.invite.changed");
      }
      try {
        const service = this.host.bindings.SPACE_INVITATIONS;
        if (!service) throw new Error("Signup invitation service is unavailable");
        await service.cancel({ version: 1, installationId: this.host.installationId, contactInviteId: inviteId });
        this.host.connectionRuntime.broadcastToUserUid(invite.ownerUid, "contact.invite.changed");
      } catch (error) {
        this.host.tasks.enqueue(new Date(Date.now() + 60_000), {
          callback: "onSignupInvitationCleanup", payload: inviteId,
        }, { idempotent: true, excludeTaskId: taskId });
        await this.arm();
        throw error;
      }
    });
  }
}
