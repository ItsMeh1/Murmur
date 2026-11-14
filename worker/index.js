import { DurableObject } from "cloudflare:workers";

const API_VERSION = "1";
const CHANNELS = new Set(["general", "ideas", "pending", "orchestrate"]);
const WIDGETS = new Set(["approval", "plan", "orchestrate", "choice", "progress"]);
const MAX_MESSAGES = 1000;
const MAX_MEMBERS = 64;
const MAX_MESSAGE_LENGTH = 4000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function fail(message, status = 400, code = "bad_request") {
  return json({ error: { code, message } }, status);
}

function randomHex(bytes = 24) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, value => value.toString(16).padStart(2, "0")).join("");
}

function makeRoomId() {
  return "room_" + randomHex(8);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

function clean(value, max = MAX_MESSAGE_LENGTH) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredOrigins(env) {
  return String(env.CORS_ORIGINS || "https://itsmeh1.github.io,http://localhost:8000,http://127.0.0.1:8000")
    .split(",").map(value => value.trim()).filter(Boolean);
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = configuredOrigins(env);
  return allowed.includes("*") || allowed.includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = configuredOrigins(env);
  const allowOrigin = !origin ? "*" : (allowed.includes("*") ? "*" : origin);
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-expose-headers": "Content-Type, X-Murmur-API-Version",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "x-murmur-api-version": API_VERSION
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  if (response.status === 101 && response.webSocket) {
    return new Response(null, { status: 101, webSocket: response.webSocket, headers });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readJson(request) {
  try {
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 64 * 1024) return null;
    return await request.json();
  } catch {
    return null;
  }
}

async function proxyRoom(env, id, path, request) {
  const url = new URL(request.url);
  url.protocol = "https:";
  url.hostname = "room.internal";
  url.port = "";
  url.pathname = path;
  const stub = env.ROOMS.getByName(id);
  return stub.fetch(new Request(url.toString(), request));
}

function routeRoomPath(url) {
  const match = url.pathname.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{1,80})(\/.*)?$/);
  if (!match) return null;
  return { id: match[1], path: match[2] || "/" };
}

export default {
  async fetch(request, env) {
    try {
      if (!isAllowedOrigin(request, env)) {
        return withCors(fail("Origin is not allowed.", 403, "origin_denied"), request, env);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      const url = new URL(request.url);
      let response;

      if (url.pathname === "/v1/health" && request.method === "GET") {
        response = json({
          ok: true,
          service: "murmur-api",
          apiVersion: API_VERSION,
          protocol: "murmur.v1",
          transports: ["http-json", "websocket"]
        });
      } else if (url.pathname === "/v1/openapi.json" && request.method === "GET") {
        response = json({
          openapi: "3.1.0",
          info: {
            title: "Murmur API",
            version: "1.0.0",
            description: "Provider-neutral JSON API for rooms, humans, agents, messages and realtime events."
          },
          servers: [{ url: url.origin }],
          paths: {
            "/v1/health": { get: { operationId: "health", responses: { "200": { description: "API health" } } } },
            "/v1/rooms": {
              post: {
                operationId: "createRoom",
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string", maxLength: 24 } } } } } },
                responses: { "201": { description: "Room created" } }
              }
            },
            "/v1/rooms/{roomId}/join": {
              post: {
                operationId: "joinRoom",
                parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["inviteCode", "name"], properties: { inviteCode: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["human", "agent"] } } } } } },
                responses: { "200": { description: "Joined room" } }
              }
            },
            "/v1/rooms/{roomId}": {
              get: {
                operationId: "getRoom",
                security: [{ bearerAuth: [] }],
                parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "Room metadata" } }
              },
              delete: {
                operationId: "closeRoom",
                security: [{ bearerAuth: [] }],
                parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "Room closed" } }
              }
            },
            "/v1/rooms/{roomId}/members": {
              get: {
                operationId: "getMembers",
                security: [{ bearerAuth: [] }],
                parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "Room members" } }
              }
            },
            "/v1/rooms/{roomId}/messages": {
              get: {
                operationId: "getMessages",
                security: [{ bearerAuth: [] }],
                parameters: [
                  { name: "roomId", in: "path", required: true, schema: { type: "string" } },
                  { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
                  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
                  { name: "channel", in: "query", schema: { type: "string", enum: ["general", "ideas", "pending", "orchestrate"] } }
                ],
                responses: { "200": { description: "Messages and next cursor" } }
              },
              post: {
                operationId: "sendMessage",
                security: [{ bearerAuth: [] }],
                parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 4000 }, channel: { type: "string", enum: ["general", "ideas", "pending", "orchestrate"] }, target: { type: "string", maxLength: 24 } } } } } },
                responses: { "201": { description: "Message accepted" } }
              }
            },
            "/v1/rooms/{roomId}/widgets": {
              post: {
                operationId: "createWidget",
                security: [{ bearerAuth: [] }],
                parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }],
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["widgetType", "data"], properties: { widgetType: { type: "string", enum: ["approval", "plan", "orchestrate", "choice", "progress"] }, data: { type: "object" }, channel: { type: "string" } } } } } },
                responses: { "201": { description: "Widget accepted" } }
              }
            },
            "/v1/rooms/{roomId}/connect-ticket": {
              post: {
                operationId: "createConnectionTicket",
                security: [{ bearerAuth: [] }],
                parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "Short-lived single-use WebSocket ticket" } }
              }
            }
          },
          components: {
            securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }
          }
        });
      } else if (url.pathname === "/v1/rooms" && request.method === "POST") {
        const body = await readJson(request);
        if (!isObject(body)) {
          response = fail("Expected a JSON request body.");
        } else {
          const name = clean(body.name || "You", 24);
          if (!/^[A-Za-z0-9_]{1,24}$/.test(name)) {
            response = fail("Name must be 1–24 letters, numbers or underscores.", 400, "invalid_name");
          } else {
            const id = makeRoomId();
            const inviteCode = randomHex(24);
            const accessToken = randomHex(32);
            const stub = env.ROOMS.getByName(id);
            response = await stub.fetch("https://room.internal/_create", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ roomId: id, inviteCode, accessToken, name })
            });
          }
        }
      } else {
        const route = routeRoomPath(url);
        if (!route) {
          response = fail("Route not found.", 404, "not_found");
        } else {
          response = await proxyRoom(env, route.id, route.path, request);
        }
      }

      return withCors(response, request, env);
    } catch (error) {
      return withCors(fail(error?.message || "Unexpected API error.", 500, "internal_error"), request, env);
    }
  }
};

export class MurmurRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async _state() {
    return (await this.ctx.storage.get("state")) || null;
  }

  async _mutate(callback) {
    return this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get("state");
      if (!state) throw new Error("Room not found.");
      const result = await callback(state);
      await transaction.put("state", state);
      return result;
    });
  }

  async _authorize(request) {
    const header = request.headers.get("Authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const tokenHash = await sha256(match[1]);
    const state = await this._state();
    return state?.credentials?.[tokenHash] || null;
  }

  _membersWithPresence(state) {
    const socketMembers = new Set(
      this.ctx.getWebSockets()
        .map(socket => socket.deserializeAttachment()?.member?.id)
        .filter(Boolean)
    );
    const now = Date.now();
    return state.members.map(member => {
      const presence = state.presence?.[member.id];
      const heartbeatOnline = presence?.online === true && now - Number(presence.lastSeen || 0) < 65000;
      return { ...member, online: socketMembers.has(member.id) || heartbeatOnline };
    });
  }

  _broadcast(event) {
    const frame = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(frame); } catch {}
    }
  }

  async _recordEvent(type, payload = {}, mutateState = null) {
    const event = await this._mutate(state => {
      const extra = mutateState ? (mutateState(state) || {}) : {};
      state.sequence += 1;
      const item = { type, ...payload, ...extra, cursor: state.sequence };
      state.events ||= [];
      state.events.push(item);
      if (state.events.length > MAX_MESSAGES * 3) {
        state.events.splice(0, state.events.length - MAX_MESSAGES * 3);
      }
      return item;
    });
    this._broadcast(event);
    return event;
  }

  async _appendMessage(message, type = "message.created") {
    const event = await this._mutate(state => {
      state.sequence += 1;
      message.cursor = state.sequence;
      state.messages.push(message);
      if (state.messages.length > MAX_MESSAGES) {
        state.messages.splice(0, state.messages.length - MAX_MESSAGES);
      }
      const item = { type, message, cursor: state.sequence };
      state.events ||= [];
      state.events.push(item);
      if (state.events.length > MAX_MESSAGES * 3) {
        state.events.splice(0, state.events.length - MAX_MESSAGES * 3);
      }
      return item;
    });
    this._broadcast(event);
    return event;
  }

  async _systemMessage(text) {
    return this._appendMessage({
      id: "msg_" + randomHex(12),
      cursor: 0,
      channel: "general",
      author: "Murmur",
      text,
      mentions: [],
      target: null,
      createdAt: new Date().toISOString(),
      sender: { id: "system", name: "Murmur", kind: "system" },
      widget: null
    });
  }

  async _create(request) {
    const body = await readJson(request);
    if (!isObject(body) || !body.roomId || !body.inviteCode || !body.accessToken) {
      return fail("Invalid room creation payload.");
    }
    if (await this._state()) return fail("Room already exists.", 409, "room_exists");

    const owner = {
      id: "owner",
      name: clean(body.name, 24) || "You",
      kind: "human",
      role: "owner",
      createdAt: new Date().toISOString()
    };
    const credentials = {};
    credentials[await sha256(body.accessToken)] = owner;

    await this.ctx.storage.put("state", {
      room: {
        id: body.roomId,
        createdAt: new Date().toISOString(),
        protocol: "murmur.v1"
      },
      inviteHash: await sha256(body.inviteCode),
      members: [owner],
      credentials,
      messages: [],
      events: [],
      presence: {},
      sequence: 0,
      tickets: {}
    });

    return json({
      roomId: body.roomId,
      inviteCode: body.inviteCode,
      accessToken: body.accessToken,
      member: owner
    }, 201);
  }

  async _join(request) {
    const body = await readJson(request);
    if (!isObject(body)) return fail("Expected a JSON request body.");

    const name = clean(body.name, 24);
    if (!/^[A-Za-z0-9_]{1,24}$/.test(name) || name.toLowerCase() === "you") {
      return fail("Name must be 1–24 letters, numbers or underscores, and cannot be You.", 400, "invalid_name");
    }

    const state = await this._state();
    if (!state) return fail("Room not found.", 404, "room_not_found");
    if (await sha256(String(body.inviteCode || "")) !== state.inviteHash) {
      return fail("Invite code is incorrect.", 403, "invalid_invite");
    }
    if (state.members.length >= MAX_MEMBERS) return fail("This room is full.", 409, "room_full");
    if (state.members.some(member => member.name.toLowerCase() === name.toLowerCase())) {
      return fail("That name is already in use.", 409, "name_taken");
    }

    const accessToken = randomHex(32);
    const member = {
      id: "member_" + randomHex(8),
      name,
      kind: body.kind === "human" ? "human" : "agent",
      role: "member",
      createdAt: new Date().toISOString()
    };
    const tokenHash = await sha256(accessToken);

    await this._mutate(next => {
      next.members.push(member);
      next.credentials[tokenHash] = member;
    });

    await this._recordEvent("member.joined", { member: { ...member, online: false } });
    await this._systemMessage(name + " joined the room.");
    return json({ roomId: state.room.id, accessToken, member }, 201);
  }

  async _connect(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return fail("WebSocket upgrade required.", 426, "upgrade_required");
    }

    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",").map(value => value.trim());
    const ticketProtocol = protocols.find(value => value.startsWith("ticket."));
    if (!ticketProtocol) return fail("A one-time connection ticket is required.", 401, "ticket_required");

    const ticketHash = await sha256(ticketProtocol.slice("ticket.".length));
    const state = await this._state();
    const ticket = state?.tickets?.[ticketHash];
    if (!ticket || ticket.expiresAt < Date.now()) {
      return fail("Connection ticket is invalid or expired.", 401, "invalid_ticket");
    }

    await this._mutate(next => { delete next.tickets[ticketHash]; });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ member: ticket.member });

    const current = await this._state();
    server.send(JSON.stringify({
      type: "welcome",
      protocol: "murmur.v1",
      room: current.room,
      participant: ticket.member,
      members: this._membersWithPresence(current),
      history: current.messages.slice(-300),
      cursor: current.sequence
    }));
    this._broadcast({ type: "presence.changed", members: this._membersWithPresence(current) });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "murmur.v1" }
    });
  }

  async _handleEvent(member, event) {
    if (!isObject(event) || typeof event.type !== "string") {
      throw new Error("Invalid event.");
    }

    if (event.type === "message.send") {
      const text = clean(event.text);
      if (!text) throw new Error("Message cannot be empty.");
      const message = {
        id: "msg_" + randomHex(12),
        cursor: 0,
        channel: CHANNELS.has(event.channel) ? event.channel : "general",
        author: member.name,
        text,
        mentions: [...text.matchAll(/@([A-Za-z0-9_]+)/g)].map(match => match[1]).slice(0, 20),
        target: clean(event.target, 24) || null,
        createdAt: new Date().toISOString(),
        sender: { id: member.id, name: member.name, kind: member.kind },
        widget: null
      };
      await this._appendMessage(message);
      return { accepted: true, messageId: message.id };
    }

    if (event.type === "widget.create") {
      const type = event.widgetType;
      const data = isObject(event.data) ? event.data : {};
      if (!WIDGETS.has(type)) throw new Error("Unsupported widget type.");
      let normalized;

      if (type === "approval") {
        const title = clean(data.title, 120);
        if (!title) throw new Error("Approval widgets need a title.");
        normalized = { title, details: clean(data.details, 2000), action: clean(data.action, 1000) };
      } else if (type === "plan") {
        const title = clean(data.title, 120);
        const steps = Array.isArray(data.steps)
          ? data.steps.slice(0, 20).map(value => clean(value, 240)).filter(Boolean)
          : [];
        if (!title || !steps.length) throw new Error("Plan widgets need a title and steps.");
        normalized = { title, steps };
      } else if (type === "orchestrate") {
        const task = clean(data.task, 2000);
        const followers = Array.isArray(data.followers)
          ? data.followers.slice(0, 10).map(value => clean(value, 24)).filter(Boolean)
          : [];
        if (!task) throw new Error("Orchestration widgets need a task.");
        normalized = { lead: member.name, followers, task };
      } else if (type === "choice") {
        const question = clean(data.question, 500);
        const options = Array.isArray(data.options)
          ? data.options.slice(0, 8).map(value => clean(value, 120)).filter(Boolean)
          : [];
        if (!question || options.length < 2) throw new Error("Choice widgets need a question and options.");
        normalized = { question, options };
      } else {
        const label = clean(data.label, 120);
        const percent = Number(data.percent);
        if (!label || !Number.isFinite(percent)) throw new Error("Progress widgets need a label and percentage.");
        normalized = { label, percent: Math.max(0, Math.min(100, percent)) };
      }

      const channel = CHANNELS.has(event.channel)
        ? event.channel
        : (type === "progress" ? "general" : "pending");
      const message = {
        id: clean(event.id, 100) || "widget_" + randomHex(12),
        cursor: 0,
        channel,
        author: member.name,
        text: "",
        mentions: [],
        target: null,
        createdAt: new Date().toISOString(),
        sender: { id: member.id, name: member.name, kind: member.kind },
        widget: { type, data: normalized, result: null }
      };
      await this._appendMessage(message, "widget.created");
      return { accepted: true, widgetId: message.id };
    }

    if (event.type === "widget.respond") {
      const resultEvent = await this._recordEvent("widget.resolved", {
        id: event.id
      }, state => {
        const message = state.messages.find(item => item.id === event.id && item.widget);
        if (!message || message.widget.type === "progress") throw new Error("Widget not found.");
        if (message.widget.result) throw new Error("Widget has already been resolved.");
        if (["approval", "plan", "orchestrate"].includes(message.widget.type) && member.role !== "owner") {
          throw new Error("Only the room owner can resolve this widget.");
        }
        if (message.widget.type === "choice") {
          const choice = clean(event.result?.choice, 120);
          if (!message.widget.data.options.includes(choice)) throw new Error("Invalid choice.");
          message.widget.result = { approved: true, choice };
        } else {
          message.widget.result = {
            approved: event.result?.approved === true,
            ...(Array.isArray(event.result?.steps) ? { steps: event.result.steps.slice(0, 20) } : {})
          };
        }
        return { result: message.widget.result };
      });
      return { accepted: true, cursor: resultEvent.cursor };
    }

    if (event.type === "progress.update") {
      const progressEvent = await this._recordEvent("progress.updated", {
        id: event.id
      }, state => {
        const message = state.messages.find(item => item.id === event.id && item.widget?.type === "progress");
        if (!message) throw new Error("Progress widget not found.");
        if (member.role !== "owner" && message.sender?.id !== member.id) {
          throw new Error("Only the creator or room owner can update progress.");
        }
        const percent = Number(event.percent);
        if (!Number.isFinite(percent)) throw new Error("Progress percentage must be numeric.");
        message.widget.data.percent = Math.max(0, Math.min(100, percent));
        return { percent: message.widget.data.percent };
      });
      return { accepted: true, cursor: progressEvent.cursor };
    }

    throw new Error("Unsupported event type.");
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/_create" && request.method === "POST") return this._create(request);
    if (url.pathname === "/join" && request.method === "POST") return this._join(request);
    if (url.pathname === "/connect" && request.method === "GET") return this._connect(request);

    const member = await this._authorize(request);
    if (!member) return fail("Missing or invalid bearer access token.", 401, "unauthorized");

    if (url.pathname === "/" && request.method === "GET") {
      const state = await this._state();
      return json({
        room: state.room,
        participant: member,
        members: this._membersWithPresence(state),
        messageCount: state.messages.length,
        cursor: state.sequence
      });
    }

    if (url.pathname === "/" && request.method === "DELETE") {
      if (member.role !== "owner") return fail("Only the room owner can close this room.", 403, "forbidden");
      this._broadcast({ type: "room.closed" });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(1000, "Room closed by owner"); } catch {}
      }
      await this.ctx.storage.deleteAll();
      return json({ closed: true });
    }

    if (url.pathname === "/connect-ticket" && request.method === "POST") {
      const ticketValue = randomHex(24);
      const ticketHash = await sha256(ticketValue);
      await this._mutate(state => {
        state.tickets[ticketHash] = { member, expiresAt: Date.now() + 60000 };
      });
      return json({ ticket: ticketValue, expiresIn: 60 });
    }

    if (url.pathname === "/members" && request.method === "GET") {
      const state = await this._state();
      return json({ members: this._membersWithPresence(state) });
    }

    if (url.pathname === "/presence" && request.method === "POST") {
      const body = await readJson(request);
      const online = body?.online !== false;
      await this._mutate(state => {
        state.presence ||= {};
        state.presence[member.id] = { online, lastSeen: Date.now() };
      });
      const state = await this._state();
      const event = { type: "presence.changed", members: this._membersWithPresence(state) };
      this._broadcast(event);
      return json({ updated: true, online });
    }

    if (url.pathname === "/messages" && request.method === "GET") {
      const state = await this._state();
      const after = Math.max(0, Number(url.searchParams.get("after") || 0));
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 100)));
      const channel = url.searchParams.get("channel");
      let messages = state.messages.filter(item =>
        item.cursor > after && (!channel || item.channel === channel)
      );
      const total = messages.length;
      messages = messages.slice(0, limit);
      return json({
        messages,
        total,
        nextCursor: messages.at(-1)?.cursor || after,
        cursor: state.sequence
      });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      const state = await this._state();
      const after = Math.max(0, Number(url.searchParams.get("after") || 0));
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 100)));
      const events = (state.events || []).filter(item => item.cursor > after);
      const page = events.slice(0, limit);
      return json({
        events: page,
        total: events.length,
        nextCursor: page.at(-1)?.cursor || after,
        cursor: state.sequence
      });
    }

    if (url.pathname === "/messages" && request.method === "POST") {
      const body = await readJson(request);
      if (!isObject(body)) return fail("Expected a JSON request body.");
      try {
        const result = await this._handleEvent(member, {
          type: "message.send",
          text: body.text,
          channel: body.channel,
          target: body.target
        });
        const state = await this._state();
        return json({ ...result, cursor: state.sequence }, 201);
      } catch (error) {
        return fail(error.message, 400, "invalid_message");
      }
    }

    if (url.pathname === "/widgets" && request.method === "POST") {
      const body = await readJson(request);
      if (!isObject(body) || !isObject(body.data)) return fail("widgetType and data are required.");
      try {
        const result = await this._handleEvent(member, {
          type: "widget.create",
          id: body.id,
          widgetType: body.widgetType,
          data: body.data,
          channel: body.channel
        });
        return json(result, 201);
      } catch (error) {
        return fail(error.message, 400, "invalid_widget");
      }
    }

    const responseMatch = url.pathname.match(/^\/widgets\/([A-Za-z0-9_-]+)\/respond$/);
    if (responseMatch && request.method === "POST") {
      const body = await readJson(request);
      try {
        const result = await this._handleEvent(member, {
          type: "widget.respond",
          id: responseMatch[1],
          result: body?.result || body
        });
        return json(result);
      } catch (error) {
        return fail(error.message, 403, "widget_response_rejected");
      }
    }

    const progressMatch = url.pathname.match(/^\/widgets\/([A-Za-z0-9_-]+)\/progress$/);
    if (progressMatch && request.method === "POST") {
      const body = await readJson(request);
      try {
        const result = await this._handleEvent(member, {
          type: "progress.update",
          id: progressMatch[1],
          percent: body?.percent
        });
        return json(result);
      } catch (error) {
        return fail(error.message, 403, "progress_update_rejected");
      }
    }

    if (url.pathname === "/leave" && request.method === "POST") {
      if (member.role === "owner") return fail("The room owner must close the room.", 403, "owner_action_required");
      await this._mutate(state => {
        state.members = state.members.filter(item => item.id !== member.id);
        for (const [hash, value] of Object.entries(state.credentials)) {
          if (value.id === member.id) delete state.credentials[hash];
        }
      });
      await this._recordEvent("member.left", { member });
      await this._systemMessage(member.name + " left the room.");
      return json({ left: true });
    }

    return fail("Room route not found.", 404, "not_found");
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    if (!attachment?.member) {
      socket.close(1008, "Missing participant");
      return;
    }
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (text.length > 64000) throw new Error("Event is too large.");
      const event = JSON.parse(text);
      await this._handleEvent(attachment.member, event);
    } catch (error) {
      try { socket.send(JSON.stringify({ type: "error", error: error.message || "Invalid event." })); } catch {}
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    const memberId = attachment?.member?.id;
    let state = await this._state();
    if (state && memberId) {
      const stillConnected = this.ctx.getWebSockets().some(
        current => current.deserializeAttachment()?.member?.id === memberId
      );
      if (!stillConnected) {
        await this._mutate(next => {
          next.presence ||= {};
          next.presence[memberId] = { online: false, lastSeen: Date.now() };
        });
        state = await this._state();
      }
      this._broadcast({ type: "presence.changed", members: this._membersWithPresence(state) });
    }
  }

  async webSocketError(socket) {
    try { socket.close(1011, "WebSocket error"); } catch {}
  }
}
