// Browser Run has no user authenticator, and page capture cannot show Chrome's
// native passkey dialog. Decline WebAuthn before site scripts can open a hidden
// dialog that blocks all mouse/keyboard input, including password sign-in.
// Install at context scope so initial scripts in popups and frames see it too.
export const cloudBrowserCredentials = `(() => {
  if (!globalThis.PublicKeyCredential || !navigator.credentials) return;
  const prototype = Object.getPrototypeOf(navigator.credentials);
  const installed = Symbol.for("gsv.cloudBrowser.credentials");
  if (prototype[installed]) return;
  Object.defineProperty(prototype, installed, { value: true });
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
  PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  if (PublicKeyCredential.getClientCapabilities) {
    const capabilities = PublicKeyCredential.getClientCapabilities;
    PublicKeyCredential.getClientCapabilities = async function() {
      return Object.fromEntries(Object.keys(await capabilities.call(this)).map(key => [key, false]));
    };
  }
  for (const method of ["get", "create"]) {
    const original = prototype[method];
    Object.defineProperty(prototype, method, {
      configurable: true,
      writable: true,
      value: function(options) {
        if (options?.publicKey) return Promise.reject(new DOMException(
          "Passkeys are not available in this cloud browser. Use another sign-in method.", "NotAllowedError"));
        return Reflect.apply(original, this, arguments);
      },
    });
  }
})();`;
