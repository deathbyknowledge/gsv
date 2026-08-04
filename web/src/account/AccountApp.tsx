import { TelegramLinkPage } from "./telegram/TelegramLinkPage";
import { BillingPage } from "./billing/BillingPage";
import type { CheckoutReturn } from "./billing/useBilling";

export function AccountApp({
  pathname,
  claimToken,
  checkoutReturn,
}: {
  pathname: string;
  claimToken: string | null;
  checkoutReturn: CheckoutReturn;
}) {
  if (pathname === "/billing" || pathname === "/billing/") {
    return <BillingPage checkoutReturn={checkoutReturn} />;
  }
  return <TelegramLinkPage claimToken={claimToken} />;
}
