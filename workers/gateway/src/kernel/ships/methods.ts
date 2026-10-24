import {
  ACCEPT_INVITATION, ACCEPT_MESSAGE_REQUEST, DELIVER, GET_ATTACHMENT, SEND_MESSAGE_REQUEST, WITHDRAW_MESSAGE_REQUEST,
} from "@humansandmachines/gsv/protocol";
import { receiveMessageRequest } from "../approaches/admission";
import { acceptMessageRequest, withdrawMessageRequest } from "../approaches/pairing";
import { deliver, getAttachment } from "../federation";
import { acceptInvitation } from "../federation/invitations";
import type { ShipMethods } from "./xrpc";

/**
 * The Ship methods this Ship serves, by NSID. Making contact takes a caller
 * only a few calls a minute; deliveries and reads get twice what one contact's
 * own limits allow, which leaves room for retries.
 */
export const SHIP_METHODS: ShipMethods = new Map([
  [ACCEPT_INVITATION, { type: "procedure", callsPerMinute: 10, handle: acceptInvitation }],
  [DELIVER, { type: "procedure", callsPerMinute: 120, handle: deliver }],
  [GET_ATTACHMENT, { type: "query", callsPerMinute: 480, handle: getAttachment }],
  [SEND_MESSAGE_REQUEST, { type: "procedure", callsPerMinute: 10, handle: receiveMessageRequest }],
  [ACCEPT_MESSAGE_REQUEST, { type: "procedure", callsPerMinute: 10, handle: acceptMessageRequest }],
  [WITHDRAW_MESSAGE_REQUEST, { type: "procedure", callsPerMinute: 10, handle: withdrawMessageRequest }],
]);
