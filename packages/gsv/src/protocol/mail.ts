import type { AdapterInstallationContext } from "./adapters";
import type { BinaryBody } from "./body";
import type { ManagedMailSummary } from "./managed";

export type ManagedMailAddress = {
  address: string;
  name?: string;
};

export type ManagedMailAttachmentMetadata = {
  mimeType: string;
  size: number;
  filename?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
};

export type ManagedInboundMailMetadata = {
  version: 1;
  intakeId: string;
  digest: string;
  receivedAt: number;
  rawSize: number;
  envelope: {
    from: string;
    to: string;
  };
  rfcMessageId?: string;
  sentAt?: number;
  from?: ManagedMailAddress;
  to: ManagedMailAddress[];
  cc: ManagedMailAddress[];
  replyTo: ManagedMailAddress[];
  subject?: string;
  text?: string;
  html?: string;
  attachments: ManagedMailAttachmentMetadata[];
};

export type ManagedInboundMailAccepted = {
  messageId: string;
};

export type ManagedInboundMailCompletion = {
  version: 1;
  intakeId: string;
  messageId: string;
  summary: ManagedMailSummary;
};

export interface ManagedMailGatewayService {
  acceptManagedInboundMail(
    installation: AdapterInstallationContext,
    metadata: ManagedInboundMailMetadata,
    body: BinaryBody,
  ): Promise<ManagedInboundMailAccepted>;
  completeManagedInboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedInboundMailCompletion,
  ): Promise<void>;
}

export type ManagedMailStorageState = "pending" | "stored";

export type ManagedMailSummaryState =
  | "pending"
  | "running"
  | "notifying"
  | "deferred"
  | "complete";

export type ManagedMailIntakeDiagnostic = {
  intakeId: string;
  digest: string;
  receivedAt: number;
  rawSize: number;
  storageState: ManagedMailStorageState;
  summaryState: ManagedMailSummaryState;
  storageAttempts: number;
  summaryAttempts: number;
  completionAttempts: number;
  messageId?: string;
  storedAt?: number;
  completedAt?: number;
};

export type ListManagedMailIntakesInput = {
  cursor?: string;
  limit?: number;
};

export type ManagedMailIntakePage = {
  items: ManagedMailIntakeDiagnostic[];
  cursor?: string;
};

export interface ManagedMailService {
  getIntake(
    installation: AdapterInstallationContext,
    intakeId: string,
  ): Promise<ManagedMailIntakeDiagnostic | null>;
  listIntakes(
    installation: AdapterInstallationContext,
    input?: ListManagedMailIntakesInput,
  ): Promise<ManagedMailIntakePage>;
}
