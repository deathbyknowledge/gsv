export const GSV_SERVICE_WORKER_URL = "/gsv-service-worker.js";

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export function canUseServiceWorker(): boolean {
  return "serviceWorker" in navigator && window.isSecureContext;
}

export function registerGsvServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!canUseServiceWorker()) {
    return Promise.resolve(null);
  }

  registrationPromise ??= navigator.serviceWorker
    .register(GSV_SERVICE_WORKER_URL)
    .catch(() => null);
  return registrationPromise;
}
