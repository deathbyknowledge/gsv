import {
  ACCEPT_INVITATION, ACCEPT_MESSAGE_REQUEST, DELIVER, GET_ATTACHMENT, SEND_MESSAGE_REQUEST, WITHDRAW_MESSAGE_REQUEST,
} from "@humansandmachines/gsv/protocol";
import { receiveMessageRequest } from "../approaches/admission";
import { acceptMessageRequest, withdrawMessageRequest } from "../approaches/pairing";
import { deliver, getAttachment } from "../federation";
import { acceptInvitation } from "../federation/invitations";
import type { ShipMethods } from "./xrpc";

/** The Ship methods this Ship serves, by NSID. */
export const SHIP_METHODS: ShipMethods = new Map([
  [ACCEPT_INVITATION, { type: "procedure", handle: acceptInvitation }],
  [DELIVER, { type: "procedure", handle: deliver }],
  [GET_ATTACHMENT, { type: "query", handle: getAttachment }],
  [SEND_MESSAGE_REQUEST, { type: "procedure", handle: receiveMessageRequest }],
  [ACCEPT_MESSAGE_REQUEST, { type: "procedure", handle: acceptMessageRequest }],
  [WITHDRAW_MESSAGE_REQUEST, { type: "procedure", handle: withdrawMessageRequest }],
]);
