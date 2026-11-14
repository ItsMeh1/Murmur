import test from "node:test";
import assert from "node:assert/strict";
import { MurmurClient } from "../sdk/api.mjs";

test("HTTP-only clients can join, write, poll events, and heartbeat without WebSocket", async () => {
  const oldWebSocket = globalThis.WebSocket;
  const oldFetch = globalThis.fetch;
  globalThis.WebSocket = undefined;

  const calls = [];
  let delivered = false;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: parsed.pathname, method, body });

    if (parsed.pathname.endsWith("/join") && method === "POST") {
      return Response.json({
        roomId: "room_http",
        accessToken: "http-agent-token",
        member: { id: "member_http", name: "PythonLike", kind: "agent", role: "member" }
      }, { status: 201 });
    }

    if (parsed.pathname === "/v1/rooms/room_http" && method === "GET") {
      return Response.json({
        room: { id: "room_http" },
        participant: { id: "member_http", name: "PythonLike", kind: "agent", role: "member" },
        members: [],
        cursor: 0
      });
    }

    if (parsed.pathname.endsWith("/messages") && method === "GET") {
      return Response.json({ messages: [], total: 0, nextCursor: 0, cursor: 0 });
    }

    if (parsed.pathname.endsWith("/events") && method === "GET") {
      const after = Number(parsed.searchParams.get("after") || 0);
      if (delivered && after < 1) {
        return Response.json({
          events: [{
            type: "message.created",
            cursor: 1,
            message: {
              id: "msg_from_human",
              cursor: 1,
              channel: "general",
              author: "Human",
              text: "Can you hear me?",
              mentions: [],
              target: null,
              createdAt: new Date().toISOString(),
              sender: { id: "human", name: "Human", kind: "human" },
              widget: null
            }
          }],
          total: 1,
          nextCursor: 1,
          cursor: 1
        });
      }
      return Response.json({ events: [], total: 0, nextCursor: after, cursor: after });
    }

    if (parsed.pathname.endsWith("/members") && method === "GET") {
      return Response.json({ members: [] });
    }

    if (parsed.pathname.endsWith("/presence") && method === "POST") {
      return Response.json({ updated: true, online: body?.online !== false });
    }

    if (parsed.pathname.endsWith("/messages") && method === "POST") {
      assert.equal(options.headers.authorization, "Bearer http-agent-token");
      assert.equal(body.text, "HTTP agents can write too.");
      delivered = true;
      return Response.json({ accepted: true, messageId: "msg_http", cursor: 1 }, { status: 201 });
    }

    if (parsed.pathname.endsWith("/presence") && method === "POST") {
      return Response.json({ updated: true });
    }

    throw new Error("Unexpected request: " + method + " " + parsed.pathname);
  };

  try {
    const client = new MurmurClient({ apiBase: "https://api.example.test" });
    const received = [];
    client.on("message", message => received.push(message));

    await client.connect({
      room: "room_http",
      token: "room-invite",
      name: "PythonLike",
      kind: "agent"
    });

    assert.equal(client.connected, true);
    assert.equal(client.participant.name, "PythonLike");

    await client.sendMessage("HTTP agents can write too.");
    await new Promise(resolve => setTimeout(resolve, 20));
    await client.pollEvents();

    assert.ok(calls.some(call => call.path.endsWith("/join") && call.method === "POST"));
    assert.ok(calls.some(call => call.path.endsWith("/events") && call.method === "GET"));
    assert.ok(calls.some(call => call.path.endsWith("/messages") && call.method === "POST"));
    assert.ok(calls.some(call => call.path.endsWith("/presence") && call.method === "POST"));
    assert.ok(received.some(message => message.text === "Can you hear me?"));

    client.close();
  } finally {
    globalThis.WebSocket = oldWebSocket;
    globalThis.fetch = oldFetch;
  }
});
