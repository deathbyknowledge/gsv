import {
  installationResetPreparedSchema,
  type InstallationResetService,
} from "@humansandmachines/gsv/services/lifecycle";
import { AccountStore, type InstallationResetReservation } from "./store";

export class InstallationResetCoordinator {
  constructor(
    private readonly db: D1Database,
    private readonly accounts: AccountStore,
    private readonly participants: Readonly<Record<string, InstallationResetService>>,
  ) {}

  async reset(input: {
    installationId: string;
    operationId: string;
    confirmHandle: string;
  }): Promise<InstallationResetReservation> {
    const reset = await this.accounts.resetInstallation({
      ...input, participants: Object.keys(this.participants),
    });
    await this.prepare(reset);
    return reset;
  }

  async prepare(reset: InstallationResetReservation): Promise<void> {
    const pending = await this.db.prepare(
      `SELECT participant_id FROM installation_reset_participants
       WHERE operation_id = ? AND state = 'pending' ORDER BY participant_id`,
    ).bind(reset.operationId).all<{ participant_id: string }>();
    if (pending.results.length === 0) return;
    await this.db.prepare(
      `UPDATE installation_reset_participants SET updated_at = ?
       WHERE operation_id = ? AND state = 'pending'`,
    ).bind(Date.now(), reset.operationId).run();
    const attempts = await Promise.allSettled(pending.results.map(async ({ participant_id: id }) => {
      const participant = Object.hasOwn(this.participants, id) ? this.participants[id] : undefined;
      if (!participant) throw new Error("installation reset participant is unavailable");
      const input = {
        version: 1 as const,
        operationId: reset.operationId,
        previousInstallationId: reset.previousInstallationId,
        replacementInstallationId: reset.installationId,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        participant.prepareInstallationReset(input),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("installation reset participant timed out")), 10_000);
        }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      const receipt = installationResetPreparedSchema.parse(result);
      if (receipt.operationId !== input.operationId
        || receipt.previousInstallationId !== input.previousInstallationId
        || receipt.replacementInstallationId !== input.replacementInstallationId) {
        throw new Error("installation reset acknowledgment did not match the operation");
      }
      await this.db.prepare(
        `UPDATE installation_reset_participants SET state = 'prepared', updated_at = ?
         WHERE operation_id = ? AND participant_id = ? AND state = 'pending'`,
      ).bind(Date.now(), reset.operationId, id).run();
    }));
    const failed = attempts.find((attempt) => attempt.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async resumePending(): Promise<{ prepared: number; pending: number }> {
    const operations = await this.db.prepare(
      `SELECT operation_id FROM installation_reset_participants
       WHERE state = 'pending' GROUP BY operation_id
       ORDER BY MIN(updated_at), operation_id LIMIT 10`,
    ).all<{ operation_id: string }>();
    let prepared = 0;
    let pending = 0;
    for (const { operation_id: operationId } of operations.results) {
      const reset = await this.accounts.getResetByOperation(operationId);
      if (!reset) throw new Error("installation reset operation is unavailable");
      try {
        await this.prepare(reset);
        prepared += 1;
      } catch {
        pending += 1;
      }
    }
    return { prepared, pending };
  }
}
