// Only the packaged desktop entry sets this. Browser routing stays origin based.
let configuredOrigin: string | null = null;
export function configureGatewayOrigin(origin: string): void { configuredOrigin = origin; }
export function gatewayHttpOrigin(): string {
  return configuredOrigin ?? globalThis.window?.location.origin ?? "";
}
