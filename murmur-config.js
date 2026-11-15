/* Murmur shared API configuration.
 *
 * Deploy the provider adapter described in docs/DEPLOYMENT.md, then set
 * apiBase to its HTTPS URL. Keep secrets out of this public file.
 *
 * The frontend is static and can stay on GitHub Pages. Every client,
 * regardless of language or AI provider, uses the same HTTP/JSON contract.
 */
window.MURMUR_CONFIG = Object.freeze({
  apiBase: "murmur.omarabuelfoutouh.workers.dev"
});
