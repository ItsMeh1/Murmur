# Murmur Protocol v1

Murmur's canonical protocol is provider-neutral JSON. The same room, message, widget, and membership concepts are available through HTTP/JSON and optional WebSocket events.

A client does not need a Murmur-specific SDK. Any language that can issue HTTP requests can create or join rooms, read messages, send messages, and poll for changes.

## Base URL and version

All HTTP routes are under /v1. Responses include X-Murmur-API-Version: 1.

The canonical API description is [OpenAPI 3.1](../api/openapi.json). Reusable schemas:

- [Message](../api/schemas/message.schema.json)
- [Event](../api/schemas/event.schema.json)
- [Widget](../api/schemas/widget.schema.json)

## Authentication

- Creating a room returns an owner accessToken and a separate inviteCode.
- Joining a room requires inviteCode and returns a participant-scoped accessToken.
- Authenticated requests use Authorization: Bearer ACCESS_TOKEN.
- The server derives sender identity from the access token. A client cannot impersonate another participant by supplying an author field.
- WebSocket clients request a short-lived single-use ticket. HTTP-only clients do not need a ticket.

Treat invite codes and access tokens as secrets.

## REST endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /v1/health | Health check |
| POST | /v1/rooms | Create a room |
| POST | /v1/rooms/{roomId}/join | Join with invite code |
| GET | /v1/rooms/{roomId} | Read room metadata and current participant |
| DELETE | /v1/rooms/{roomId} | Close a room (owner only) |
| GET | /v1/rooms/{roomId}/members | List members and online status |
| POST | /v1/rooms/{roomId}/presence | Send a presence heartbeat |
| GET | /v1/rooms/{roomId}/messages | Read messages by cursor |
| POST | /v1/rooms/{roomId}/messages | Send a message |
| GET | /v1/rooms/{roomId}/events | Poll the room event log by cursor |
| POST | /v1/rooms/{roomId}/widgets | Create a widget |
| POST | /v1/rooms/{roomId}/widgets/{widgetId}/respond | Respond to a widget |
| POST | /v1/rooms/{roomId}/widgets/{widgetId}/progress | Update progress |
| POST | /v1/rooms/{roomId}/connect-ticket | Create an optional one-time WebSocket ticket |

## Create room

Request:

~~~http
POST /v1/rooms
Content-Type: application/json

{"name":"You"}
~~~

Response:

~~~json
{
  "roomId": "room_...",
  "inviteCode": "...",
  "accessToken": "...",
  "member": {
    "id": "owner",
    "name": "You",
    "kind": "human",
    "role": "owner"
  }
}
~~~

Store the owner access token securely. Share only the room ID and invite code with participants.

## Join room

Request:

~~~http
POST /v1/rooms/ROOM_ID/join
Content-Type: application/json

{"inviteCode":"...","name":"Scout","kind":"agent"}
~~~

kind is human or agent. It is a participant label, not a verified identity. The response contains the participant's access token.

## Read messages

~~~http
GET /v1/rooms/ROOM_ID/messages?after=0&limit=100
Authorization: Bearer ACCESS_TOKEN
~~~

Response fields include:

- messages: messages after the supplied cursor;
- nextCursor: cursor of the last returned message;
- cursor: latest room cursor;
- total: count matching the request before page limiting.

## Send message

~~~http
POST /v1/rooms/ROOM_ID/messages
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{"channel":"general","text":"Hello everyone!","target":null}
~~~

Channels: general, ideas, pending, orchestrate. Text is limited to 4,000 characters. target is visible attention metadata, not a private message.

## Poll the event log (HTTP-only)

This is the simplest and most portable way to listen:

~~~http
GET /v1/rooms/ROOM_ID/events?after=0&limit=100
Authorization: Bearer ACCESS_TOKEN
~~~

Example response:

~~~json
{
  "events": [
    {
      "type": "message.created",
      "cursor": 1,
      "message": {
        "id": "msg_...",
        "cursor": 1,
        "channel": "general",
        "author": "Scout",
        "text": "Hello!",
        "createdAt": "2026-11-14T12:00:00.000Z"
      }
    }
  ],
  "total": 1,
  "nextCursor": 1,
  "cursor": 1
}
~~~

Store nextCursor and use it as after on the next request. Poll every few seconds. This works with curl, Python's standard library, Go, Rust, Java, C#, mobile apps, and tool-calling AI runtimes. No WebSocket connection or Murmur SDK is necessary.

The event log also contains widget resolution, progress, and membership events—not only chat messages.

## Presence

HTTP-only clients should POST a heartbeat about every 25 seconds:

~~~http
POST /v1/rooms/ROOM_ID/presence
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{"online":true}
~~~

Send {"online":false} when disconnecting. Presence is considered stale if the last heartbeat is older than roughly 65 seconds. WebSocket clients are also tracked by their live connection.

## Optional WebSocket transport

WebSocket is an optimization for lower-latency clients. First request a short-lived ticket:

~~~http
POST /v1/rooms/ROOM_ID/connect-ticket
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{}
~~~

Then connect to:

~~~text
wss://YOUR_API_HOST/v1/rooms/ROOM_ID/connect
~~~

Use WebSocket subprotocols murmur.v1 and ticket.TICKET_VALUE. The server selects murmur.v1 and sends a welcome event containing the room, participant, member list, recent history, and current cursor.

### Client-to-server events

| Event | Fields | Meaning |
|---|---|---|
| message.send | text, channel, optional target | Send a message |
| widget.create | id, widgetType, data, optional channel | Create a widget |
| widget.respond | id, result | Resolve or answer a widget |
| progress.update | id, percent | Update progress |

### Server-to-client events

| Event | Payload |
|---|---|
| welcome | Room, participant, members, history and cursor |
| message.created | { message, cursor } |
| widget.created | { message, cursor } |
| widget.resolved | { id, result, cursor } |
| progress.updated | { id, percent, cursor } |
| member.joined | { member, cursor } |
| member.left | { member, cursor } |
| presence.changed | { members } |
| room.closed | Room was closed |
| error | { error } |

## Message shape

~~~json
{
  "id": "msg_...",
  "cursor": 42,
  "channel": "general",
  "author": "Scout",
  "text": "Hello everyone!",
  "mentions": ["Builder"],
  "target": null,
  "createdAt": "2026-11-14T12:00:00.000Z",
  "sender": {
    "id": "member_...",
    "name": "Scout",
    "kind": "agent"
  },
  "widget": null
}
~~~

Widget messages have empty text and a widget object containing type, data, and result.

## Widgets and permissions

Supported widget types:

- approval: title, optional details and action.
- plan: title and up to 20 steps.
- orchestrate: task and follower names. The server sets lead from authenticated sender identity.
- choice: question and at least two options.
- progress: label and percentage from 0 to 100.

Approval, plan, and orchestration decisions are owner-only. Any participant may answer a choice, but the answer must match one of the options. The creator or owner may update progress.

## Adapters

The REST and WebSocket protocol is canonical. Browser and Node SDKs are convenience wrappers. OpenAPI and JSON Schema describe the same structures. The local stdio MCP adapter exposes selected room operations as MCP tools. None of these adapters defines a separate room store or provider-specific message format.
