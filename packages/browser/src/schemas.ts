import { z } from "zod";

export function isString<T>(value: T): value is T & string {
  return z.string().safeParse(value).success;
}

export function isNumber<T>(value: T): value is T & number {
  return z.number().safeParse(value).success;
}

export function isBoolean<T>(value: T): value is T & boolean {
  return z.boolean().safeParse(value).success;
}
