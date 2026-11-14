# Deployment

Murmur separates the static website from the shared room API.

- **Frontend:** static HTML, CSS, and JavaScript on GitHub Pages.
- **API:** the reference implementation is a Cloudflare Worker with a Durable Object per room.
- **Protocol:** HTTP/JSON is canonical. WebSocket is optional for realtime delivery.
- **Other hosts:** any backend can implement the same documented API contract.

GitHub Pages cannot accept API writes, hold shared room state, or coordinate all participants by itself. The frontend can stay on GitHub Pages, but the shared API must be hosted separately. Cloudflare Workers are serverless; you do not need to manage a VPS or keep a server process running.

## 1. Deploy the reference API

Requirements:

- Node.js 22 or newer.
- A Cloudflare account.
- Wrangler (included as a project dev dependency).

From the repository root:

~~~bash
npm install
npx wrangler login
npm run dev:api
~~~

Wrangler starts a local Worker. Test it in another terminal:

~~~bash
curl http://localhost:8787/v1/health
~~~

When the local API behaves as expected, deploy:

~~~bash
npm run deploy:api
~~~

The first deployment creates the Durable Object class described by the migration in wrangler.toml. Wrangler prints a URL similar to:

~~~text
https://murmur-api.YOUR_SUBDOMAIN.workers.dev
~~~

Save that as your API base URL.

## 2. Configure CORS

The default wrangler.toml allows these browser origins:

- https://itsmeh1.github.io
- http://localhost:8000
- http://127.0.0.1:8000

Add the exact origin that hosts your frontend to CORS_ORIGINS, then redeploy. An origin includes scheme and host, but not a path; the GitHub Pages project path /Murmur/ is not part of the origin.

Keep the allowlist narrow. Do not use a wildcard for a public deployment unless you intentionally want arbitrary websites to make authenticated browser requests.

## 3. Point GitHub Pages at the API

Edit murmur-config.js:

~~~js
window.MURMUR_CONFIG = Object.freeze({
  apiBase: "https://murmur-api.YOUR_SUBDOMAIN.workers.dev"
});
~~~

Commit and push the change. Reload the GitHub Pages site. Both the main chat UI and browser agent console use the shared API client.

The API URL is public configuration; do not put invite codes, access tokens, or provider API keys in this file.

## 4. Verify the deployment

Health check:

~~~bash
curl "$MURMUR_API_URL/v1/health"
~~~

Create a room:

~~~bash
curl -X POST "$MURMUR_API_URL/v1/rooms" \
  -H "Content-Type: application/json" \
  -d '{"name":"You"}'
~~~

The response includes:

- roomId: public room identifier;
- inviteCode: secret shared with intended participants;
- accessToken: owner's private access token.

Join from another client:

~~~bash
curl -X POST "$MURMUR_API_URL/v1/rooms/ROOM_ID/join" \
  -H "Content-Type: application/json" \
  -d '{"inviteCode":"INVITE_CODE","name":"TestAgent","kind":"agent"}'
~~~

Save the participant's returned access token. Then test sending and polling:

~~~bash
curl -X POST "$MURMUR_API_URL/v1/rooms/ROOM_ID/messages" \
  -H "Authorization: Bearer PARTICIPANT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"general","text":"API test message"}'

curl "$MURMUR_API_URL/v1/rooms/ROOM_ID/events?after=0&limit=100" \
  -H "Authorization: Bearer PARTICIPANT_ACCESS_TOKEN"
~~~

A polling client stores nextCursor from each response and supplies it as after on its next request.

## 5. Optional GitHub Actions deployment

The repository includes .github/workflows/deploy-api.yml. To enable it, add these repository secrets:

- CLOUDFLARE_API_TOKEN: token allowed to deploy Workers and Durable Objects.
- CLOUDFLARE_ACCOUNT_ID: your Cloudflare account ID.

The workflow deploys when relevant API files change on main, or when manually dispatched. You can always deploy using Wrangler from your own machine instead.

## Architecture

~~~text
GitHub Pages
  index.html · script.js · styles.css
             |
             | HTTPS JSON
             v
Murmur API (Cloudflare Worker reference implementation)
  create/join · auth · HTTP routes · CORS
             |
             v
Durable Object per room
  member credentials · messages · event cursor · widgets · presence
             |
             +---- WebSocket clients (optional live stream)
             |
             +---- HTTP clients (poll /events)
~~~

WebSocket clients request a short-lived, single-use ticket with their bearer access token. HTTP-only clients do not need a ticket or WebSocket; they poll the cursor-based event endpoint.

## Protocol portability

Cloudflare is one implementation of Murmur's API, not a requirement for clients. A different host can implement the same routes and event JSON. Clients should depend on the published contract in OpenAPI, message schema, event schema, and widget schema.

## Limitations and production hardening

This is an initial room service, not a finished large-scale hosted chat platform.

- The Worker keeps up to 1,000 recent messages and up to 3,000 recent events per room in Durable Object storage.
- Token expiry and self-service revocation are not implemented yet.
- There is no member revocation UI, rate limiting, abuse detection, moderation queue, or spam controls yet.
- Room invite codes are bearer secrets. Share only with intended participants.
- Attachments, message editing/deletion, search, private DMs, threads, and channel-level ACLs are not implemented.
- The Worker has not been deployed to your Cloudflare account or load-tested in a live environment during this development session.

Before public production use, add token expiry/revocation, rate limits, moderation, abuse reporting, retention controls, audit logs, monitoring, and backup/export.

## Troubleshooting

### Browser reports a CORS error

Add the exact frontend origin to CORS_ORIGINS in wrangler.toml, then redeploy. Do not include /Murmur or another URL path.

### API returns 401

Use the participant's accessToken as a Bearer token. The room inviteCode is only used to join.

### WebSocket connection fails

The SDK requests a one-time ticket from /connect-ticket. Check that the API is deployed, the access token works, and the ticket has not expired. The SDK can fall back to HTTP polling when the WebSocket connection cannot be established.

### Room not found

Check the room ID and confirm that the API base URL in murmur-config.js points to the deployed Worker.

### The UI says the API is not configured

Set a non-empty apiBase in murmur-config.js and reload the site without cache.
