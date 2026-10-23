import { ACCEPT_INVITATION, DELIVER, GET_ATTACHMENT } from "@humansandmachines/gsv/protocol";
import { deliver, getAttachment } from "../federation";
import { acceptInvitation } from "../federation/invitations";
import type { ShipMethods } from "./xrpc";

/** The Ship methods this Ship serves, by NSID. */
export const SHIP_METHODS: ShipMethods = new Map([
  [ACCEPT_INVITATION, { type: "procedure", handle: acceptInvitation }],
  [DELIVER, { type: "procedure", handle: deliver }],
  [GET_ATTACHMENT, { type: "query", handle: getAttachment }],
]);
