import * as z from "zod/mini";

export const jsonPrimitiveSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
]);
export const jsonValueSchema = z.json();
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonPrimitive = null | boolean | number | string;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
