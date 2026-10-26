import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstallationOwnerConfirmationService,
  OwnerConfirmationCheck,
  OwnerConfirmationCheckResult,
  OwnerConfirmationRequest,
  OwnerConfirmationRequestResult,
  OwnerNotice,
} from "@humansandmachines/gsv/services/owner-confirmations";

/** The code this stand-in for Accounts emails for every change. */
export const INTEGRATION_CONFIRMATION_CODE = "424242";
const OPEN = new Map<string, string>();
const NOTICES: OwnerNotice[] = [];

/** Stands in for Accounts' owner confirmations: one open code per installation, for the change it was asked about. */
export class IntegrationOwnerConfirmations extends WorkerEntrypoint implements InstallationOwnerConfirmationService {
  async requestOwnerConfirmation(input: OwnerConfirmationRequest): Promise<OwnerConfirmationRequestResult> {
    OPEN.set(input.installationId, input.subjectHash);
    return { status: "sent", to: "o•••@example.com", expiresAt: Date.now() + 600_000, retryAt: Date.now() + 60_000 };
  }

  async confirmOwnerConfirmation(input: OwnerConfirmationCheck): Promise<OwnerConfirmationCheckResult> {
    if (OPEN.get(input.installationId) !== input.subjectHash) return { status: "expired" };
    if (input.code !== INTEGRATION_CONFIRMATION_CODE) return { status: "wrong", attemptsLeft: 4 };
    OPEN.delete(input.installationId);
    return { status: "confirmed" };
  }

  async notifyOwner(input: OwnerNotice): Promise<{ sent: boolean }> {
    NOTICES.push(input);
    return { sent: true };
  }

  /** The notices it would have emailed, for tests. */
  async notices(): Promise<OwnerNotice[]> {
    return NOTICES;
  }
}
