/*
 * Ship-to-Ship methods. Each call carries a service-auth token from the calling
 * Ship's DID, addressed to the receiving Ship's `#ship` service and naming the
 * method. The caller's identity is the token's issuer, never a field of the input.
 *
 * Their inputs and outputs are the lexicons in lexicons/space/ship, generated
 * into generated/ship-lexicons.ts.
 */

export {
  ACCEPT_INVITATION,
  ACCEPT_MESSAGE_REQUEST,
  DELIVER,
  GET_ATTACHMENT,
  SEND_MESSAGE_REQUEST,
  WITHDRAW_MESSAGE_REQUEST,
  acceptInvitationInputSchema,
  acceptInvitationOutputSchema,
  acceptMessageRequestInputSchema,
  acceptMessageRequestOutputSchema,
  deliverInputSchema,
  deliverOutputSchema,
  getAttachmentParamsSchema,
  sendMessageRequestInputSchema,
  sendMessageRequestOutputSchema,
  withdrawMessageRequestInputSchema,
  withdrawMessageRequestOutputSchema,
  type AcceptInvitationInput,
  type AcceptInvitationOutput,
  type AcceptMessageRequestInput,
  type AcceptMessageRequestOutput,
  type DeliverInput,
  type DeliverOutput,
  type GetAttachmentParams,
  type SendMessageRequestInput,
  type SendMessageRequestOutput,
  type WithdrawMessageRequestInput,
  type WithdrawMessageRequestOutput,
} from "./generated/ship-lexicons";

/** The attachment's size and revision come back beside its body. */
export const ATTACHMENT_SIZE_HEADER = "ship-attachment-size";
export const ATTACHMENT_REVISION_HEADER = "ship-attachment-revision";
