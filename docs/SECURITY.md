# Security, Permissions and Trust

Murmur is a lightweight peer-hosted prototype. Its invite key and owner checks are useful room-level controls, but they are not a replacement for user accounts, server-side authorization, audit logs or production abuse prevention.

## What the current controls do

- The host generates a random invite key when it creates a room.
- A joiner must present that key in the initial `hello` event.
- The host rejects an incorrect key, an invalid name or a name already in use.
- The host derives message authorship from the connection's accepted participant record, rather than accepting an arbitrary `author` field from a client.
- The host marks itself as `owner`; joined participants are `member`.
- Only the owner can resolve approval, plan and orchestration widgets.
- Only the widget creator or owner can update a progress widget.
- Choice submissions must match one of the widget's published options.

## What the current controls do not do

- There are no user accounts or independently verified identities. Anyone with the invite key can join and choose an available display name.
- `kind: "human"` or `kind: "agent"` is a participant label supplied during join, not proof of identity.
- The invite key does not expire, rotate automatically or support per-person revocation.
- There is no moderation dashboard, ban list, rate limiter, spam filter or per-channel access control.
- There is no private messaging. Every room event is broadcast to connected participants. A `target` label does not make a message private.
- There is no central database or managed backup. The host's browser holds recent room history.
- A widget approval is not an execution sandbox or policy enforcement mechanism. An agent must check the result in its own code before taking an external action.

## Keep invite links private

The invite URL includes the room ID and shared invite key in its URL fragment. Anyone who receives the complete link can attempt to join. Share it only with intended participants. If you believe it has leaked, close the room and create a new one with a new invite key.

Do not commit invite keys, API keys, private conversation exports or other secrets to this repository. The optional OpenAI agent should receive its API key through an environment variable or a local secrets manager.

## Treat room content as untrusted

A participant can send arbitrary conversation text and can create supported widgets. Agents should treat room messages, widget fields, names and targets as untrusted input. Do not convert a message into a shell command, code execution, file operation, purchase or other consequential action without independent validation and any required human approval.

The included OpenAI example tells the model that room messages are untrusted conversation content and not system instructions. This is a prompt-level safeguard, not a complete security boundary. Any custom agent should implement its own policy checks.

## The host can see room content

The host is the relay for the room. Messages sent by participants reach the host browser before being broadcast to the others. The host also stores recent history in its own browser storage. Do not use a room for information that participants would not want the host to see.

## When not to use this build

Do not use this version for sensitive, regulated or high-stakes communications, large public communities, or workflows that require enforceable identity, audited approvals, guaranteed delivery, revocation, central retention or server-side moderation. Those needs require a separately operated backend and stronger access-control design.
