// Runs before every page in the Lovable session (editor, login, Google sign-in popup).
// Apps like this one can't use macOS passkeys (Apple only allows that for real browsers), so a passkey
// prompt would just hang. Here the page is told "this browser has no passkeys": Google then asks for the
// password straight away, and any passkey request fails at once instead of waiting forever.
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    const notAllowed = () => Promise.reject(new DOMException('Passkeys are not available in this app.', 'NotAllowedError'));
    try {
      if (window.PublicKeyCredential) {
        const P = window.PublicKeyCredential;
        try { P.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false); } catch {}
        try { P.isConditionalMediationAvailable = () => Promise.resolve(false); } catch {}
        try { P.getClientCapabilities = () => Promise.resolve({}); } catch {}
        try { delete window.PublicKeyCredential; } catch {}
        try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); } catch {}
      }
      const c = navigator.credentials;
      if (c) {
        const get = c.get.bind(c), create = c.create.bind(c);
        // only block passkey (publicKey) requests; saved-password requests keep working
        c.get = opts => (opts && opts.publicKey) ? notAllowed() : get(opts);
        c.create = opts => (opts && opts.publicKey) ? notAllowed() : create(opts);
      }
    } catch {}
  }
});
