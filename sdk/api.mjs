import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/**
 * Provider-neutral Murmur HTTP/JSON + WebSocket SDK for Node.js 22+.
 * Any language can use the same documented REST endpoints without this SDK.
 */
export class MurmurClient extends EventEmitter {
  constructor({ apiBase = process.env.MURMUR_API_URL || "", fetchImpl = globalThis.fetch } = {}) {
    super();
    this.apiBase = String(apiBase).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.room = null;
    this.inviteToken = null;
    this.accessToken = null;
    this.participant = null;
    this.members = [];
    this.history = [];
    this.cursor = 0;
    this.connected = false;
    this.isHost = false;
    this.socket = null;
    this._closing = false;
    this._pollTimer = null;
    this._polling = false;
    this._heartbeatTimer = null;
  }

  async request(path, { method = "GET", body } = {}) {
    if (!this.apiBase) throw new Error("Set MURMUR_API_URL to your Murmur API base URL.");
    const headers = { accept: "application/json" };
    if (this.accessToken) headers.authorization = "Bearer " + this.accessToken;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetch(this.apiBase + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || data?.message || ("Murmur API HTTP " + response.status));
    }
    return data;
  }

  async openSocket() {
    if (typeof globalThis.WebSocket !== "function") {
      return this.startPolling("WebSocket is unavailable in this runtime.");
    }
    const ticket = await this.request(
      "/v1/rooms/" + encodeURIComponent(this.room) + "/connect-ticket",
      { method: "POST", body: {} }
    );
    const url = new URL(this.apiBase + "/v1/rooms/" + encodeURIComponent(this.room) + "/connect");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(url, ["murmur.v1", "ticket." + ticket.ticket]);
        this.socket = socket;
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.close();
          reject(new Error("Timed out connecting to Murmur."));
        }, 20000);

        socket.addEventListener("message", event => {
          let payload;
          try {
            payload = JSON.parse(String(event.data));
          } catch {
            this.emit("clientError", new Error("Murmur sent invalid JSON."));
            return;
          }
          if (payload.type === "welcome") {
            this.connected = true;
            this.participant = payload.participant;
            this.members = payload.members || [];
            this.history = payload.history || [];
            this.cursor = Number(payload.cursor) || 0;
            this.emit("event", payload);
            this.startHeartbeat();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(this);
            }
            return;
          }
          this.receive(payload);
        });

        socket.addEventListener("error", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("Murmur WebSocket connection failed."));
          }
        });

        socket.addEventListener("close", event => {
          const wasConnected = this.connected;
          this.connected = false;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("Socket closed before welcome (" + event.code + ")."));
          }
          if (wasConnected && !this._closing) {
          this.emit("transportFallback", { transport: "http-polling", reason: "WebSocket disconnected." });
          this.startPolling("WebSocket disconnected").catch(error => {
            this.emit("clientError", error);
            this.emit("disconnected", { code: event.code, reason: error.message });
          });
        } else if (wasConnected) {
          this.emit("disconnected", { code: event.code });
        }
        });
      });
    } catch (error) {
      // HTTP remains a complete transport when WebSocket is blocked.
      return this.startPolling(error.message || "WebSocket connection failed.");
    }
  }

  startHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    const beat = () => {
      if (!this.connected || !this.accessToken || !this.room) return;
      this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/presence", {
        method: "POST",
        body: { online: true }
      }).catch(error => this.emit("clientError", error));
    };
    beat();
    this._heartbeatTimer = setInterval(beat, 25000);
  }

  async startPolling(reason = "WebSocket unavailable") {
    const snapshot = await this.getRoom();
    this.participant = snapshot.participant;
    this.members = snapshot.members || [];
    this.isHost = this.participant?.role === "owner";
    await this.getHistory({ limit: 300 });
    this.connected = true;
    this._closing = false;
    this.startHeartbeat();
    this.emit("transportFallback", { transport: "http-polling", reason });
    this.emit("event", {
      type: "welcome",
      participant: this.participant,
      members: this.members,
      history: this.history,
      cursor: this.cursor
    });
    this.pollEvents();
    this._pollTimer = setInterval(() => this.pollEvents(), 2500);
    return this;
  }

  async pollEvents() {
    if (!this.connected || this._closing || this._polling) return;
    this._polling = true;
    try {
      const result = await this.getEvents({ after: this.cursor, limit: 200 });
      for (const event of result.events || []) {
        this.cursor = Math.max(this.cursor || 0, Number(event.cursor) || 0);
        this.receive(event);
      }
      const roster = await this.getMembers();
      this.receive({ type: "presence.changed", members: roster.members || [] });
    } catch (error) {
      this.emit("clientError", error);
    } finally {
      this._polling = false;
    }
  }

  async createRoom({ name = "You" } = {}) {
    const data = await this.request("/v1/rooms", {
      method: "POST",
      body: { name }
    });
    this.room = data.roomId;
    this.inviteToken = data.inviteCode;
    this.accessToken = data.accessToken;
    this.participant = data.member;
    this.isHost = true;
    await this.openSocket();
    return {
      roomId: this.room,
      inviteCode: this.inviteToken,
      inviteToken: this.inviteToken,
      accessToken: this.accessToken,
      participant: this.participant
    };
  }

  async connect({ room, token, name, kind = "agent" }) {
    if (!room || !token || !name) throw new Error("Room ID, invite code and name are required.");
    const data = await this.request("/v1/rooms/" + encodeURIComponent(room) + "/join", {
      method: "POST",
      body: { inviteCode: token, name, kind }
    });
    this.room = data.roomId;
    this.inviteToken = token;
    this.accessToken = data.accessToken;
    this.participant = data.member;
    this.isHost = false;
    await this.openSocket();
    return this;
  }

  async resume({ room, accessToken, inviteCode } = {}) {
    if (!room || !accessToken) throw new Error("Room ID and access token are required.");
    this.room = room;
    this.accessToken = accessToken;
    this.inviteToken = inviteCode || null;
    const snapshot = await this.request("/v1/rooms/" + encodeURIComponent(room));
    this.participant = snapshot.participant;
    this.members = snapshot.members || [];
    this.isHost = snapshot.participant?.role === "owner";
    await this.getHistory({ limit: 200 });
    await this.openSocket();
    return this;
  }

  receive(event) {
    if (!event || typeof event.type !== "string") return;
    this.cursor = Math.max(this.cursor, Number(event.cursor) || Number(event.message?.cursor) || 0);

    if (event.type === "message.created" || event.type === "widget.created") {
      if (event.message && !this.history.some(item => item.id === event.message.id)) {
        this.history.push(event.message);
        if (this.history.length > 1000) this.history.shift();
      }
      this.emit(event.type === "message.created" ? "message" : "widget", event.message);
    } else if (event.type === "widget.resolved") {
      const message = this.history.find(item => item.id === event.id);
      if (message?.widget) message.widget.result = event.result;
      this.emit("widgetResolved", event);
    } else if (event.type === "progress.updated") {
      const message = this.history.find(item => item.id === event.id);
      if (message?.widget) message.widget.data.percent = event.percent;
      this.emit("progress", event);
    } else if (event.type === "members.updated" || event.type === "presence.changed") {
      this.members = event.members || [];
      this.emit("members", this.members);
    } else if (event.type === "member.joined") {
      if (!this.members.some(item => item.id === event.member?.id)) this.members.push(event.member);
      this.emit("memberJoined", event.member);
    } else if (event.type === "member.left") {
      this.members = this.members.filter(item => item.id !== event.member?.id);
      this.emit("memberLeft", event.member);
    } else if (event.type === "room.closed") {
      this.connected = false;
      this.emit("disconnected", { reason: "The room was closed." });
    } else if (event.type === "error") {
      this.emit("serverError", event);
    }

    this.emit("event", event);
  }

  submit(event) {
    if (!this.connected) throw new Error("Not connected to Murmur.");
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(event));
      return Promise.resolve({ sent: true });
    }

    let path;
    let body;
    if (event.type === "message.send") {
      path = "/messages";
      body = { text: event.text, channel: event.channel, target: event.target };
    } else if (event.type === "widget.create") {
      path = "/widgets";
      body = { id: event.id, widgetType: event.widgetType, data: event.data, channel: event.channel };
    } else if (event.type === "widget.respond") {
      path = "/widgets/" + encodeURIComponent(event.id) + "/respond";
      body = { result: event.result };
    } else if (event.type === "progress.update") {
      path = "/widgets/" + encodeURIComponent(event.id) + "/progress";
      body = { percent: event.percent };
    } else {
      throw new Error("Unsupported HTTP event: " + event.type);
    }

    return this.request("/v1/rooms/" + encodeURIComponent(this.room) + path, {
      method: "POST",
      body
    }).catch(error => {
      this.emit("clientError", error);
      throw error;
    });
  }

  sendMessage(text, options = {}) {
    return this.submit({
      type: "message.send",
      text,
      channel: options.channel || "general",
      target: options.target || null
    });
  }

  createWidget(widgetType, data, options = {}) {
    const id = "widget_" + randomUUID();
    return this.submit({
      type: "widget.create",
      id,
      widgetType,
      data,
      channel: options.channel
    }).then(() => id);
  }

  respondToWidget(id, result) {
    return this.submit({ type: "widget.respond", id, result });
  }

  updateProgress(id, percent) {
    return this.submit({ type: "progress.update", id, percent });
  }

  async getHistory({ channel, limit = 100, after = 0 } = {}) {
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(200, limit))),
      after: String(Math.max(0, after))
    });
    if (channel) params.set("channel", channel);
    const data = await this.request(
      "/v1/rooms/" + encodeURIComponent(this.room) + "/messages?" + params
    );
    if (after === 0) this.history = data.messages || [];
    else {
      for (const message of data.messages || []) {
        if (!this.history.some(item => item.id === message.id)) this.history.push(message);
      }
    }
    this.cursor = Math.max(this.cursor, Number(data.cursor) || 0);
    return data;
  }

  async getEvents({ after = 0, limit = 100 } = {}) {
    const params = new URLSearchParams({
      after: String(Math.max(0, after)),
      limit: String(Math.max(1, Math.min(200, limit)))
    });
    return this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/events?" + params);
  }

  async getEvents({ after = 0, limit = 100 } = {}) {
    const params = new URLSearchParams({
      after: String(Math.max(0, Number(after) || 0)),
      limit: String(Math.max(1, Math.min(200, Number(limit) || 100)))
    });
    return this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/events?" + params);
  }

  async getMembers() {
    const data = await this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/members");
    this.members = data.members || [];
    return data;
  }

  async getEvents({ after = 0, limit = 100 } = {}) {
    const params = new URLSearchParams({
      after: String(Math.max(0, Number(after) || 0)),
      limit: String(Math.max(1, Math.min(200, Number(limit) || 100)))
    });
    return this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/events?" + params);
  }

  async getRoom() {
    return this.request("/v1/rooms/" + encodeURIComponent(this.room));
  }

  waitForMessage({ timeout = 0, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const listener = message => {
        try {
          if (!predicate(message)) return;
          cleanup();
          resolve(message);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const cleanup = () => {
        this.off("message", listener);
        if (timer) clearTimeout(timer);
      };
      this.on("message", listener);
      if (timeout > 0) timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
    });
  }

  async endRoom() {
    if (!this.isHost) throw new Error("Only the room owner can close this room.");
    const data = await this.request("/v1/rooms/" + encodeURIComponent(this.room), { method: "DELETE" });
    this.close();
    return data;
  }

  async leave() {
    const data = await this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/leave", {
      method: "POST",
      body: {}
    });
    this.close();
    return data;
  }

  close() {
    this._closing = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
    if (this.connected && this.accessToken && this.room) {
      this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/presence", {
        method: "POST",
        body: { online: false }
      }).catch(() => {});
    }
    try { this.socket?.close(1000, "Client closed"); } catch {}
    this.socket = null;
    this.connected = false;
    this.accessToken = null;
    this.emit("closed");
  }
}

export default MurmurClient;
