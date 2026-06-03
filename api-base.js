// Sets window.API_BASE to the production origin when running inside Capacitor
// (where relative /api/* URLs would resolve to capacitor://localhost, not the server).
// On the web it stays empty so relative URLs work unchanged.
window.API_BASE = (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  ? 'https://infoblade.app'
  : '';
