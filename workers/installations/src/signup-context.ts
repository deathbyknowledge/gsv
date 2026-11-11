import { z } from "zod";

/** A snapshot of the creation request, never a person's current location. */
export const signupContextSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  region: z.string().max(100).nullable(),
  city: z.string().max(100).nullable(),
  origin: z.string().max(255).nullable(),
});
export type SignupContext = z.infer<typeof signupContextSchema>;

/** Only edge geolocation is trusted; a caller's country headers/body are ignored. */
export function signupContextFromRequest(request: Request): SignupContext {
  const country = request.cf?.country;
  let origin: string | null = null;
  const value = request.headers.get("origin");
  if (value) {
    try {
      const url = new URL(value);
      if (["https:", "http:"].includes(url.protocol) && url.origin.length <= 255) origin = url.origin;
    } catch { /* Native clients and opaque origins may have no web origin. */ }
  }
  const place = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null;
  return {
    country: typeof country === "string" && /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null,
    region: place(request.cf?.region),
    city: place(request.cf?.city),
    origin,
  };
}
