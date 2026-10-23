import { ACCEPT_INVITATION } from "@humansandmachines/gsv/protocol";
import { acceptInvitation } from "../federation/invitations";
import type { ShipMethods } from "./xrpc";

/** The Ship methods this Ship serves, by NSID. */
export const SHIP_METHODS: ShipMethods = new Map([
  [ACCEPT_INVITATION, { type: "procedure", handle: acceptInvitation }],
]);
