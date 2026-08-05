import { TelegramLinkPage } from "./telegram/TelegramLinkPage";
import { BillingPage } from "./billing/BillingPage";
import type { CheckoutReturn } from "./billing/useBilling";
import { AccountHomePage } from "./home/AccountHomePage";
import type { AccountRoute } from "./home/view";

export function AccountApp({
  pathname,
  claimToken,
  verificationToken,
  checkoutReturn,
}: {
  pathname: string;
  claimToken: string | null;
  verificationToken: string | null;
  checkoutReturn: CheckoutReturn;
}) {
  if (pathname === "/billing" || pathname === "/billing/") {
    return <BillingPage checkoutReturn={checkoutReturn} />;
  }
  if (pathname === "/telegram" || pathname === "/telegram/") {
    return <TelegramLinkPage claimToken={claimToken} />;
  }
  const route: AccountRoute = pathname === "/verify" || pathname === "/verify/"
    ? "verify"
    : pathname === "/recover" || pathname === "/recover/"
      ? "recover"
      : "home";
  return (
    <AccountHomePage
      route={route}
      verificationToken={verificationToken}
      checkoutReturn={checkoutReturn}
    />
  );
}
