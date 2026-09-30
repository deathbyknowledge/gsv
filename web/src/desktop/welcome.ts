import { ONBOARDING_KEY, OwnerWelcome } from "../app/services/session/ownerWelcome";
import { invoke, type NativeSessionStorage } from "./bridge";

const accountsOrigin = import.meta.env.VITE_GSV_ACCOUNTS_ORIGIN || "https://gsv.space";

export async function loadDesktopWelcome(): Promise<OwnerWelcome> {
  const snapshot = await invoke("desktop_welcome");
  return new OwnerWelcome(snapshot, {
    save: (revision, value) => invoke("desktop_save_welcome", { revision, value }),
  }, accountsOrigin);
}

export async function completeDesktopOnboarding(storage: NativeSessionStorage): Promise<void> {
  const welcome = await loadDesktopWelcome();
  await welcome.completeCreation();
  storage.removeItem(ONBOARDING_KEY);
  await storage.flush();
}
