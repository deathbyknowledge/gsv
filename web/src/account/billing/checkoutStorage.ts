const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKOUT_OPERATION_PREFIX = "gsv.billing.checkout.";

export function rememberedCheckoutOperation(
  installationId: string,
): string | null {
  try {
    const key = sessionStorage.getItem(checkoutStorageKey(installationId));
    if (key && IDEMPOTENCY_KEY_PATTERN.test(key)) return key;
    forgetCheckoutOperation(installationId);
  } catch {
    // Storage can be unavailable without making billing unavailable.
  }
  return null;
}

export function rememberCheckoutOperation(
  installationId: string,
  key: string,
): void {
  try {
    sessionStorage.setItem(checkoutStorageKey(installationId), key);
  } catch {
    // Callers retain the same key in memory for the current page instance.
  }
}

export function forgetCheckoutOperation(installationId: string): void {
  try {
    sessionStorage.removeItem(checkoutStorageKey(installationId));
  } catch {
    // This key contains no credential material and cleanup is best effort.
  }
}

function checkoutStorageKey(installationId: string): string {
  return `${CHECKOUT_OPERATION_PREFIX}${installationId}`;
}
