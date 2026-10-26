import {
  deliverMessageRefSchema,
  deliverProvenanceSchema,
  deliverSocialSchema,
  type DeliverMessageRef,
  type DeliverProvenance,
  type DeliverSocial,
} from "./generated/ship-lexicons";

export { didSchema } from "./did";

/* A message's social metadata, as the space.ship.deliver lexicon defines it. */

/** A message as its author's Ship names it. */
export type OriginMessageRef = DeliverMessageRef;
export type SocialMessageProvenance = DeliverProvenance;
export type SocialMessageMetadata = DeliverSocial;

export const originMessageRefSchema = deliverMessageRefSchema;
export const socialMessageProvenanceSchema = deliverProvenanceSchema;
export const socialMessageMetadataSchema = deliverSocialSchema;
