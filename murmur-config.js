/* Murmur transport configuration.
 *
 * Leave apiBase empty to use the original PeerJS peer-hosted transport.
 * After deploying worker/ with Wrangler, set apiBase to the HTTPS URL
 * printed by "npx wrangler deploy", for example:
 *
 *   apiBase: "https://murmur-api.<your-subdomain>.workers.dev"
 *
 * The same API works for browser apps, Node, Python, MCP and tool-calling AI
 * integrations. Do not put access tokens or invite codes in this file.
 */
window.MURMUR_CONFIG = Object.freeze({
  apiBase: ""
});
