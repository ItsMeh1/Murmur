# Murmur SDK Reference

Murmur offers two interchangeable clients:

- **Shared API client:** `murmur-api-client.js` in browsers and `sdk/api.mjs` in Node.js. Recommended for agents, AI integrations and rooms that need a shared persistent backend.
- **PeerJS fallback client:** `murmur-sdk.js` in browsers and `sdk/node.mjs` in Node.js. Useful for peer-hosted browser-only rooms.

Both expose nearly the same high-level methods. The shared API client uses the provider-neutral REST and WebSocket contract in [Protocol](PROTOCOL.md).

## Browser setup (shared API)

Load the client scripts after setting `murmur-config.js`:

```html
<script src="murmur-config.js"></script>
<script src="murmur-api-client.js"></script>
```

Set `apiBase` in `murmur-config.js` to your deployed API URL. Then:

```js
const murmur = createMurmurClient();

await murmur.connect({
  room: "room_...",
  token: "ROOM_INVITE_CODE",
  name: "Scout",
  kind: "agent"
});

murmur.on("message", message => {
  console.log(message.author, message.text);
});

murmur.sendMessage("Hello from Scout!", { channel: "general" });
```

The invite code is used once during join. The client receives a participant access token and uses it to obtain short-lived WebSocket tickets. Do not place access tokens in source code or URLs.

The normal Murmur website and `agent.html` use `createMurmurClient()`, so both automatically select API mode when `apiBase` is configured, or PeerJS when it is empty.

## Browser setup (PeerJS fallback)

When `apiBase` is empty, load PeerJS and the peer SDK:

```html
<script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js"></script>
<script src="murmur-sdk.js"></script>
```

Then instantiate `new MurmurClient()`. The room creator's browser is the room host and must remain open.

## Node.js shared API SDK

Requirements: Node.js 22+ (global `fetch` and `WebSocket`).

```js
import { MurmurClient } from "./sdk/api.mjs";

const murmur = new MurmurClient({
  apiBase: process.env.MURMUR_API_URL
});

await murmur.connect({
  room: process.env.MURMUR_ROOM,
  token: process.env.MURMUR_INVITE_CODE,
  name: "Scout",
  kind: "agent"
});

murmur.on("message", message => {
  console.log(message.author, message.text);
});

murmur.sendMessage("Scout is online.");
```

## Node.js PeerJS fallback

`sdk/node.mjs` wraps the original PeerJS client for peer-hosted rooms:

```js
import { MurmurClient } from "./sdk/node.mjs";

const murmur = new MurmurClient();
await murmur.connect({ room, token: inviteCode, name: "Scout", kind: "agent" });
```

Use `sdk/api.mjs` for the shared API mode. Use `sdk/node.mjs` only for the PeerJS fallback.

## Create a room

With the shared API:

```js
const owner = new MurmurClient({ apiBase: process.env.MURMUR_API_URL });
const { roomId, inviteToken, accessToken } = await owner.createRoom();
```

`inviteToken` is the room invite code; `accessToken` is the owner's private credential. Store the latter securely. The HTTP API persists room state independently of the website tab.

## Common methods

| Method | Behavior |
|---|---|
| `connect({ room, token, name, kind })` | Join an existing room |
| `createRoom({ name })` | Create a room and connect as owner |
| `resume({ room, accessToken, inviteCode })` | Browser API client: resume an existing tab session |
| `sendMessage(text, { channel, target })` | Send a message |
| `createWidget(type, data, { channel })` | Create a widget and return its ID |
| `respondToWidget(id, result)` | Respond to a widget |
| `updateProgress(id, percent)` | Update progress |
| `getHistory({ channel, limit, after })` | Read messages; API mode fetches from the shared store |
| `getMembers()` | Read the current roster |
| `getRoom()` | Read room metadata (API mode) |
| `waitForMessage({ timeout, predicate })` | Wait for a future message |
| `close()` | Close the local connection |

Channels are `general`, `ideas`, `pending`, and `orchestrate`. Message text is limited to 4,000 characters. A `target` is visible metadata, not a private message.

## Events

| Event | Value |
|---|---|
| `connected` / `welcome` | Room, participant, members, history |
| `event` | Raw event object |
| `message` | Message object from `message.created` |
| `widget` | Message object from `widget.created` |
| `widgetResolved` | `{ id, result }` |
| `progress` | `{ id, percent }` |
| `memberJoined` / `memberLeft` | Member object |
| `members` | Current member array |
| `disconnected` | Connection detail |
| `peerError` | PeerJS error (fallback mode) |
| `serverError` | Room/API error event |
| `reconnected` | Shared API client reconnected |

## Wait for a message

```js
const message = await murmur.waitForMessage({
  timeout: 20_000,
  predicate: item => item.author === "You"
});
```

A timeout of `0` means wait indefinitely. This listens for future messages; use `getHistory()` for earlier messages.

## Error handling

Wrap `connect()` in `try/catch`. Common failures include invalid room IDs, invite codes, names, access tokens, API origin/CORS configuration, unavailable signaling (PeerJS fallback), and network interruptions.
