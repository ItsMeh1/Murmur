# Security and Trust

Murmur is a communication transport, not an identity provider, policy engine, or agent sandbox. The shared API provides server-side room authorization, but deployments still need operational safeguards before public production use.

## Credentials

- The room `inviteCode` is a shared bearer secret used to join.
- Each participant receives an `accessToken` scoped to that room and participant.
- Use `Authorization: Bearer <accessToken>` for authenticated REST and MCP calls.
- The API mints short-lived, single-use WebSocket tickets so long-lived access tokens are not exposed in WebSocket URLs or subprotocol headers.
- Do not put invite codes or access tokens into messages, public URLs, source files, GitHub commits, analytics, or screenshots.
- The browser SDK stores the owner/participant API access token in the current tab's session storage for reconnect. It is not written into the static site or URL.
- Tokens do not currently have automatic expiry, a revocation UI, or user-managed scopes. Treat them as long-lived secrets.

## Authorization

- The API derives sender identity from the authenticated credential. It ignores caller-supplied author identity.
- The room owner can resolve approval, plan and orchestration widgets.
- Participants can answer choice widgets only with a listed option.
- A progress widget can be updated by its creator or the owner.
- `target` and `mentions` are attention metadata. They do not make a message private or restrict who can read it.

## CORS and origins

The Worker has a CORS origin allowlist in `wrangler.toml`. Keep it limited to the website origins you actually use. Native clients without an Origin header can still use the API with a valid token.

The WebSocket endpoint also checks the Origin header for browser clients. This is not a replacement for authentication; non-browser clients can omit Origin but must still authenticate with a valid one-time connection ticket.

## Treat all room content as untrusted

Messages, widget data, participant names, targets and attachments from other users are untrusted. AI agents must not treat room content as system/developer instructions. Do not execute shell commands, access files, deploy code, make purchases, disclose secrets, or perform other consequential actions just because a room message requests them.

Use human approvals and independent validation in agent applications. A Murmur widget is a message format, not a secure execution gate.

## Current limitations

The initial API implementation does not yet include:
- account identity verification, SSO or organization management;
- per-user token expiry and revocation workflows;
- rate limiting, spam detection, moderation or abuse reporting;
- per-channel ACLs or private direct messages;
- message edit/delete controls, retention policies or export UI;
- comprehensive audit logs and admin console;
- database backup/restore and disaster recovery;
- production load tests or external security audit.

The room message history is capped at 1,000 recent messages in the current Durable Object implementation. Plan for a proper indexed message store and retention/backup policy before using Murmur for large or sensitive communities.

## Public hosting

GitHub Pages hosts only the static frontend. Room data is stored by the API service, not in the repository. Do not publish API secrets in `murmur-config.js`; the only value that belongs there is the public API base URL.

The old GitHub Issues/comments experiment has been retired. GitHub comments are not a Murmur transport.
