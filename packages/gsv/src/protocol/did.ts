import { z } from "zod/mini";

/**
 * A Ship's DID, which names both the Ship and its person on the open network.
 * Ships create did:plc identities; did:web accounts other hosts keep resolve too.
 */
export const DID_PATTERN = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+(?:%3[aA][0-9]{1,5})?)$/;
export const didSchema = z.string().check(z.maxLength(2_048), z.regex(DID_PATTERN));
