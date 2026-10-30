import { PHONE_NUMBER_PATTERN } from "@humansandmachines/gsv/services/phone";
import type { PhoneRoute } from "./config";

/**
 * Numbers that must never be dialled whatever the operator allows: emergency
 * services, premium rate, directory and other special services. E.164 validation
 * already rules out short codes.
 */
const REFUSED: Array<{ prefix: string; pattern?: RegExp }> = [
  // North America: only geographic and toll-free subscriber numbers; no 900/976 or N11 services.
  { prefix: "+1", pattern: /^\+1(?![2-9]\d{2}[2-9]\d{6}$)/ },
  { prefix: "+1900" }, { prefix: "+1976" },
  { prefix: "+1", pattern: /^\+1[2-9]\d{2}[2-9]11\d{4}$/ },
  // Spain: premium rate, directory enquiries and emergency ranges.
  { prefix: "+34803" }, { prefix: "+34806" }, { prefix: "+34807" }, { prefix: "+34905" },
  { prefix: "+34118" }, { prefix: "+34112" }, { prefix: "+34091" }, { prefix: "+34092" }, { prefix: "+34061" },
  // Netherlands: premium rate and emergency.
  { prefix: "+31900" }, { prefix: "+31906" }, { prefix: "+31909" }, { prefix: "+31112" },
  // United Kingdom: premium rate, directory and emergency.
  { prefix: "+449" }, { prefix: "+44118" }, { prefix: "+44999" }, { prefix: "+44112" },
];

export type Destination = { to: string; from: string; locationHint?: PhoneRoute["locationHint"] };

/** Chooses the pool number for a destination, or refuses before anything is dialled. */
export function routeDestination(to: string, routes: readonly PhoneRoute[]): Destination {
  if (!PHONE_NUMBER_PATTERN.test(to)) throw new Error("Use an international number such as +34910000000");
  if (REFUSED.some(rule => to.startsWith(rule.prefix) && (!rule.pattern || rule.pattern.test(to)))) {
    throw new Error("This number cannot be called: emergency, premium-rate and special service numbers are refused");
  }
  const route = routes.filter(value => to.startsWith(value.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!route) throw new Error("Calls to this country are not available");
  return { to, from: route.from, locationHint: route.locationHint };
}
