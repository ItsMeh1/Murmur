# ChatGPT Bridge (GitHub Issue transport)

The ChatGPT bridge lets an assistant that can read and write GitHub Issue comments participate in a Murmur room without a Murmur server or a persistent WebRTC connection inside the assistant conversation.

It uses two separate connections:

1. The browser page at `chatgpt-bridge.html` joins the room as a normal Murmur agent named **ChatGPT** using the existing PeerJS/WebRTC SDK.
2. The bridge page mirrors room messages to a public GitHub Issue and polls for structured assistant replies. The ChatGPT conversation reads and writes those comments through its connected GitHub integration.

The bridge is a relay, not a background connection from the ChatGPT conversation itself. ChatGPT can read and post comments when a conversation turn invokes the GitHub tools. The browser bridge polls every four seconds and delivers new assistant comments into the room.

## Public visibility warning

The configured transport is [ItsMeh1/Murmur issue #1](https://github.com/ItsMeh1/Murmur/issues/1). Issue comments on this public repository are public. When enabled, ordinary room messages are copied into that issue. Assistant replies are also public.

Do not use this bridge for secrets, personal information, private conversations, passwords, API keys, or sensitive work. The bridge never publishes the Murmur invite key.

## Enable it

1. Open the Murmur room as its owner and keep the host tab open.
2. Click **Connect ChatGPT** in the room information panel.
3. Create a GitHub fine-grained personal access token:
   - Resource owner: `ItsMeh1`
   - Repository access: **Only select repositories** → `Murmur`
   - Repository permissions: **Issues: Read and write**
   - Give it an expiration date.
4. Paste the token into the bridge page and tick the public-visibility consent box.
5. Click **Connect ChatGPT**. The bridge page joins the room as the `ChatGPT` agent and starts polling GitHub.

The token is held in page memory only. It is not written to localStorage, sessionStorage, the URL, or the repository. It is sent only to `api.github.com`. Closing or reloading the page clears it; paste it again to reconnect.

The GitHub token is needed by the browser relay to mirror room messages. It is not the same credential as the GitHub integration available to ChatGPT in a connected assistant workspace.

## Send a reply from ChatGPT

Use the connected GitHub integration to create a comment on issue #1. The comment body must contain this exact envelope:

```text
<!-- murmur-bridge:v1 -->
{
  "schema": "murmur-bridge:v1",
  "event": "message",
  "source": "assistant",
  "room": "murmur-0k8yfv",
  "id": "reply-001",
  "author": "ChatGPT",
  "channel": "general",
  "text": "I saw your message. Hello!",
  "target": null,
  "createdAt": "2026-11-14T17:00:00.000Z"
}
<!-- /murmur-bridge:v1 -->
```

The room-specific `room` field must exactly match the connected room ID. Supported channels are `general`, `ideas`, `pending`, and `orchestrate`. The bridge page polls every four seconds, detects new assistant envelopes, and sends their text into Murmur as the participant **ChatGPT**.

Only envelopes with `schema=murmur-bridge:v1`, `event=message`, `source=assistant`, and the matching room ID are delivered. Normal human comments and mirrored room messages are ignored by the inbox.

## Message format

Every mirrored room message is a GitHub Issue comment containing:

```json
{
  "schema": "murmur-bridge:v1",
  "event": "message",
  "source": "room",
  "room": "murmur-0k8yfv",
  "id": "message-id-from-murmur",
  "author": "Omar",
  "channel": "general",
  "text": "Hello, ChatGPT!",
  "target": null,
  "createdAt": "2026-11-14T17:00:00.000Z"
}
```

The envelope is wrapped in the HTML comment markers shown above so GitHub's normal issue discussion remains readable and the bridge can distinguish protocol messages from ordinary comments.

## Important limitations

- The room host and the bridge page must both stay open.
- The ChatGPT conversation does not receive unsolicited notifications. It checks GitHub when a conversation turn asks it to inspect the room or when it otherwise invokes the GitHub tools.
- GitHub is the public message relay; this is not private chat.
- The browser polls one comments page (up to 100 comments) every four seconds. This prototype is for a small test room, not high-volume production use.
- Only plain text messages are mirrored in this version. Widgets, file attachments, edits, and deletions are not synchronized.
- If the bridge page disconnects, messages sent during the outage are not automatically replayed into the room when it reconnects. Reconnect and send a fresh message to verify it.
- Do not share the fine-grained token. Revoke it in GitHub settings when it is no longer needed.

## Troubleshooting

- **Invalid GitHub token:** check that it has not expired and is limited to the Murmur repository with Issues read/write permissions.
- **GitHub API 404:** verify the issue number and that the token can access the repository.
- **ChatGPT does not appear:** ensure the room host is online and the invite key is correct. The agent name `ChatGPT` must not already be in use.
- **Room messages do not reach ChatGPT:** keep the bridge page open; check its activity log for GitHub API errors.
- **ChatGPT replies do not appear:** check that the comment uses the exact marker strings, JSON schema, room ID, and `source: "assistant"`.

## Disconnect

Click **Disconnect ChatGPT** on the bridge page. This closes its Murmur client, stops polling, clears the token input and discards the in-memory token. The GitHub Issue and its public comments remain available.