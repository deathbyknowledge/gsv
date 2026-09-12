import type { AdapterInstallationContext } from "../protocol/adapters";
import type { BinaryBody } from "../protocol/body";
import type {
  ListManagedMailIntakesInput,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedMailIntakeDiagnostic,
  ManagedMailIntakePage,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailReference,
} from "../protocol/mail";
/** Mail transport contract implemented by a Gateway deployment. */
export interface MailGatewayService {
  acceptInboundMail(
    installation: AdapterInstallationContext,
    metadata: ManagedInboundMailMetadata,
    body: BinaryBody,
  ): Promise<ManagedInboundMailAccepted>;
  completeInboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedInboundMailCompletion,
  ): Promise<void>;
  claimOutboundMail(
    installation: AdapterInstallationContext,
    reference: ManagedOutboundMailReference,
  ): Promise<ManagedOutboundMailClaimOutcome>;
  completeOutboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedOutboundMailCompletion,
  ): Promise<void>;
}

/** Operational mail inspection contract implemented by a mail service. */
export interface MailService {
  getIntake(
    installation: AdapterInstallationContext,
    intakeId: string,
  ): Promise<ManagedMailIntakeDiagnostic | null>;
  listIntakes(
    installation: AdapterInstallationContext,
    input?: ListManagedMailIntakesInput,
  ): Promise<ManagedMailIntakePage>;
}

/** @deprecated Import `MailGatewayService` from `@humansandmachines/gsv/services/mail`. */
export interface ManagedMailGatewayService {
  acceptManagedInboundMail: MailGatewayService["acceptInboundMail"];
  completeManagedInboundMail: MailGatewayService["completeInboundMail"];
  claimManagedOutboundMail: MailGatewayService["claimOutboundMail"];
  completeManagedOutboundMail: MailGatewayService["completeOutboundMail"];
}
/** @deprecated Import `MailService` from `@humansandmachines/gsv/services/mail`. */
export type ManagedMailService = MailService;

export type {
  ListManagedMailIntakesInput,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedMailIntakeDiagnostic,
  ManagedMailIntakePage,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailReference,
} from "../protocol/mail";
