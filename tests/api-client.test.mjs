import test from "node:test";
import assert from "node:assert/strict";
import { MurmurClient } from "../sdk/api.mjs";

class MockWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url, protocols) {
    this.url = String(url);
    this.protocols = protocols;
    this.readyState = MockWebSocket.OPEN;
    this.listeners = new Map();
    this.sent = [];
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatch("message", {
      data: JSON.stringify({
        type: "welcome",
        room: { id: "room_test" },
        participant: { id: "member_test", name: "Scout", kind: "agent", role: "member" },
        members: [],
        history: [],
        cursor: 0
      })
    }));
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  dispatch(type, event) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatch("close", { code: 1000 }); }
}

test("API client joins, obtains a one-time WebSocket ticket and sends provider-neutral events", async () => {
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;
  const requests = [];
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket;

  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/join")) {
      return Response.json({
        roomId: "room_test",
        accessToken: "participant-token",
        member: { id: "member_test", name: "Scout", kind: "agent", role: "member" }
      });
    }
    if (parsed.pathname.endsWith("/connect-ticket")) {
      assert.equal(options.headers.authorization, "Bearer participant-token");
      return Response.json({ ticket: "one-time-ticket", expiresIn: 60 });
    }
    if (parsed.pathname.endsWith("/messages")) {
      return Response.json({ messages: [], total: 0, nextCursor: 0, cursor: 0 });
    }
    throw new Error("Unexpected request: " + parsed.pathname);
  };

  try {
    const client = new MurmurClient({ apiBase: "https://api.example.test" });
    await client.connect({
      room: "room_test",
      token: "invite-code",
      name: "Scout",
      kind: "agent"
    });

    assert.equal(client.connected, true);
    assert.equal(client.participant.name, "Scout");
    assert.equal(MockWebSocket.instances.length, 1);
    assert.deepEqual(MockWebSocket.instances[0].protocols, ["murmur.v1", "ticket.one-time-ticket"]);
    assert.ok(!MockWebSocket.instances[0].protocols.some(value => value.includes("participant-token")));

    client.sendMessage("Hello from the SDK", { channel: "general" });
    assert.deepEqual(MockWebSocket.instances[0].sent[0], {
      type: "message.send",
      text: "Hello from the SDK",
      channel: "general",
      target: null
    });

    const history = await client.getHistory({ limit: 25 });
    assert.equal(history.total, 0);
    assert.ok(requests.some(request => request.url.endsWith("/v1/rooms/room_test/connect-ticket")));
    client.close();
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.WebSocket = previousWebSocket;
  }
});
