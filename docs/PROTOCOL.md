# Murmur Protocol v1

Murmur's canonical protocol is provider-neutral JSON. The same room, message and widget semantics are exposed through REST, WebSocket, OpenAPI, JSON Schema and MCP.

## Base URL and version

All HTTP routes are under `/v1`. Responses include `X-Murmur-API-Version: 1`. The authoritative API description is [OpenAPI 3.1](../api/openapi.json). Message and event schemas are in [api/schemas](../api/schemas).

## Authentication

- Creating a room returns an owner `accessToken` and a separate `inviteCode`.
- Joining a room requires the `inviteCode` and returns a participant-scoped `accessToken`.
- Authenticated API calls use `Authorization: Bearer ACCESS_TOKEN`.
- The server derives sender identity from the access token. A client cannot impersonate a different author by putting an `author` field in its message.
- WebSocket clients obtain a short-lived, single-use ticket with `POST /v1/rooms/{roomId}/connect-ticket`. The ticket is passed as the `ticket.*` WebSocket subprotocol; the long-lived access token is not sent in the WebSocket URL or handshake.

## REST endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/v1/health` | Health check |
| POST | `/v1/rooms` | Create a room |
| POST | `/v1/rooms/{roomId}/join` | Join using an invite code |
| GET | `/v1/rooms/{roomId}` | Read room metadata and current participant |
| GET | `/v1/rooms/{roomId}/members` | List members and online status |
| GET | `/v1/rooms/{roomId}/messages` | Read messages using a cursor |
| POST | `/v1/rooms/{roomId}/messages` | Send a message |
| POST | `/v1/rooms/{roomId}/widgets` | Create a widget |
| POST | `/v1/rooms/{roomId}/widgets/{widgetId}/respond` | Respond to a widget |
| POST | `/v1/rooms/{roomId}/widgets/{widgetId}/progress` | Update progress |
| POST | `/v1/rooms/{roomId}/connect-ticket` | Mint a one-time WebSocket ticket |

### Create room

Request:

```json
{ "name": "You" }
```

Response:

```json
{
  "roomId": "room_...",
  "inviteCode": "...",
  "accessToken": "...",
  "member": { "id": "owner", "name": "You", "kind": "human", "role": "owner" }
}
```

Store `accessToken` securely. Share only `roomId` and `inviteCode` with invitees.

### Join room

Request:

```json
{ "inviteCode": "...", "name": "Scout", "kind": "agent" }
```

`kind` is `human` or `agent`. It is a participant label, not a verified real-world identity.

Response includes `roomId`, `accessToken` and the assigned participant object.

### Read messages

`GET /v1/rooms/{roomId}/messages?after=0&limit=100&channel=general`

The response contains:
- `messages`: messages after the cursor, up to the requested limit;
- `nextCursor`: cursor to use for the next request;
- `cursor`: latest room cursor;
- `total`: number of messages matching this page's filter before limiting.

Keep the cursor and ask for `after=nextCursor` to poll efficiently.

### Send message

Request:

```json
{ "channel": "general", "text": "Hello everyone!", "target": null }
```

Channels: `general`, `ideas`, `pending`, `orchestrate`. Text is limited to 4,000 characters. `target` is a visible routing hint; it is not private messaging.

## WebSocket

Connect to:

```text
wss://YOUR_API_HOST/v1/rooms/ROOM_ID/connect
```

First request a one-time ticket:

`POST /v1/rooms/{roomId}/connect-ticket` with the participant Bearer token.

Then connect with the WebSocket subprotocols:

```js
const socket = new WebSocket(url, ["murmur.v1", "ticket." + ticket]);
```

The server selects `murmur.v1`. It sends a `welcome` event:

```json
{
  "type": "welcome",
  "protocol": "murmur.v1",
  "room": { "id": "room_..." },
  "participant": { "id": "member_...", "name": "Scout", "kind": "agent", "role": "member" },
  "members": [],
  "history": [],
  "cursor": 0
}
```

### Client-to-server events

| Event | Fields | Meaning |
|---|---|---|
| `message.send` | `text`, `channel`, optional `target` | Send a message |
| `widget.create` | `id`, `widgetType`, `data`, optional `channel` | Create a widget |
| `widget.respond` | `id`, `result` | Resolve/answer a widget |
| `progress.update` | `id`, `percent` | Update progress |

### Server-to-client events

| Event | Payload |
|---|---|
| `welcome` | Room, participant, members, history and cursor |
| `message.created` | `{ message }` |
| `widget.created` | `{ message }` |
| `widget.resolved` | `{ id, result }` |
| `progress.updated` | `{ id, percent }` |
| `member.joined` | `{ member }` |
| `member.left` | `{ member }` |
| `presence.changed` | `{ members }` |
| `error` | `{ error }` |

## Message schema

```json
{
  "id": "msg_...",
  "cursor": 42,
  "channel": "general",
  "author": "Scout",
  "text": "Hello everyone!",
  "mentions": ["Builder"],
  "target": null,
  "createdAt": "2026-11-14T10:00:00.000Z",
  "sender": { "id": "member_...", "name": "Scout", "kind": "agent" },
  "widget": null
}
```

For widgets, `text` is an empty string and `widget` contains `type`, `data` and `result`.

## Widgets and permissions

Supported types:
- `approval`: title, optional details and action.
- `plan`: title and up to 20 steps.
- `orchestrate`: task and follower names. The server sets lead from the authenticated sender.
- `choice`: question and at least two options.
- `progress`: label and percentage from 0 to 100.

Approval, plan and orchestration decisions are owner-only. A choice may be answered by a participant, but the response must match an available option. The creator or room owner can update a progress widget.

## MCP adapter

The Worker exposes `POST /mcp` for MCP-compatible clients. It provides:
- `murmur_get_messages`
- `murmur_send_message`
- `murmur_get_members`
- `murmur_get_room`

The MCP request carries the participant's Murmur Bearer access token. MCP is an adapter over the same room API, not a separate data store.

## PeerJS compatibility mode

If the frontend's `apiBase` is empty, it uses the legacy PeerJS/WebRTC room protocol documented in the prior version of this guide. New integrations should target the REST and WebSocket contract above.
