import { z } from "zod";

export const signupAcquisitionSchema = z.strictObject({
  source: z.string().trim().min(1).max(100).optional(),
  medium: z.string().trim().min(1).max(100).optional(),
  campaign: z.string().trim().min(1).max(100).optional(),
  referral: z.string().trim().min(1).max(100).optional(),
  referrerHost: z.string().regex(/^[a-zA-Z0-9.-]+$/).max(253).optional(),
});
export type SignupAcquisition = z.infer<typeof signupAcquisitionSchema>;

/** A snapshot of the creation request, never a person's current location. */
export const signupContextSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  region: z.string().max(100).nullable(),
  city: z.string().max(100).nullable(),
  origin: z.string().max(255).nullable(),
  acquisition: signupAcquisitionSchema.optional(),
});
export type SignupContext = z.infer<typeof signupContextSchema>;

const placeSchema = z.string().trim().transform((value) => value.slice(0, 100) || null).nullable().catch(null);
const edgeLocationSchema = z.object({
  country: z.string().regex(/^(?!XX$)[A-Z]{2}$/).nullable().catch(null),
  region: placeSchema,
  city: placeSchema,
});

/** Only edge geolocation is trusted; a caller's country headers/body are ignored. */
export function signupContextFromRequest(request: Request, acquisition?: SignupAcquisition): SignupContext {
  const location = edgeLocationSchema.parse(request.cf ?? {});
  let origin: string | null = null;
  const value = request.headers.get("origin");
  if (value) {
    try {
      const url = new URL(value);
      if (["https:", "http:"].includes(url.protocol) && url.origin.length <= 255) origin = url.origin;
    } catch { /* Native clients and opaque origins may have no web origin. */ }
  }
  return { ...location, origin, ...(acquisition ? { acquisition } : {}) };
}
