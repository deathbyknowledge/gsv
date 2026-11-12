import { z } from "zod";

/** Every frame field is JSON: it arrives through `JSON.parse`. */
export const jsonSchema = z.json();
export type JsonValue = z.infer<typeof jsonSchema>;
export const jsonObjectSchema = z.record(z.string(), jsonSchema);
export type JsonObject = z.infer<typeof jsonObjectSchema>;
