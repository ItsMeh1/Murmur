/* Murmur's provider-neutral HTTP + WebSocket client.
 * Load after murmur-sdk.js. Configure window.MURMUR_CONFIG.apiBase to use
 * the hosted API; otherwise the existing PeerJS client remains the fallback.
 */
(function (root) {
  "use strict";

  const CHANNELS = new Set(["general", "ideas", "pending", "orchestrate"]);

  class MurmurAPIClient {
    constructor(options = {}) {
      this.baseUrl = String(options.apiBase || root.MURMUR_CONFIG?.apiBase || "").replace(/\/+$/, "");
      this.listeners = new Map();
      this.socket = null;
      this.room = null;
      this.inviteToken = null;
      this.accessToken = null;
      this.participant = null;
      this.members = [];
      this.history = [];
      this.connected = false;
      this.isHost = false;
      this._closing = false;
      this._reconnectTimer = null;
    }

    on(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
      return () => this.off(name, callback);
    }

    once(name, callback) {
      let off;
      off = this.on(name, value => { off(); callback(value); });
      return off;
    }

    off(name, callback) { this.listeners.get(name)?.delete(callback); }

    emit(name, value) {
      for (const callback of this.listeners.get(name) || []) {
        try { callback(value); } catch (error) { setTimeout(() => { throw error; }, 0); }
      }
    }

    _emitEvent(event) {
      this.emit("event", event);
      this.emit(event.type, event);
      if (event.type === "message.created") this.emit("message", event.message);
      if (event.type === "widget.created") this.emit("widget", event.message);
      if (event.type === "widget.resolved") this.emit("widgetResolved", event);
      if (event.type === "progress.updated") this.emit("progress", event);
      if (event.type === "member.joined") this.emit("memberJoined", event.member);
      if (event.type === "member.left") this.emit("memberLeft", event.member);
      if (event.type === "members.updated" || event.type === "presence.changed") {
        this.members = event.members || this.members;
        this.emit("members", this.members);
      }
      if (event.type === "error") this.emit("serverError", event);
    }

    async _request(path, options = {}) {
      if (!this.baseUrl) throw new Error("Murmur API URL is not configured. Edit murmur-config.js.");
      const headers = { "Accept": "application/json", ...(options.headers || {}) };
      if (this.accessToken) headers.Authorization = "Bearer " + this.accessToken;
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(this.baseUrl + path, {
        method: options.method || "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || data?.message || ("Murmur API returned HTTP " + response.status));
      return data;
    }

    async resume({ room, accessToken, inviteCode }) {
      if (!room || !accessToken) throw new Error("Room ID and access token are required.");
      this.room = room;
      this.accessToken = accessToken;
      this.inviteToken = inviteCode || null;
      const snapshot = await this._request("/v1/rooms/" + encodeURIComponent(room));
      this.participant = snapshot.participant;
      this.members = snapshot.members || [];
      this.isHost = snapshot.participant?.role === "owner";
      await this.getHistory({ limit: 200 });
      await this._openSocket();
      return this;
    }

    _socketUrl() {
      const url = new URL(this.baseUrl + "/v1/rooms/" + encodeURIComponent(this.room) + "/connect");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    }

    _openSocket() {
      return new Promise((resolve, reject) => {
        if (typeof root.WebSocket !== "function") return reject(new Error("This runtime does not support WebSocket."));
        const socket = new root.WebSocket(this._socketUrl(), ["murmur.v1", "bearer." + this.accessToken]);
        this.socket = socket;
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { socket.close(); } catch {}
          reject(new Error("Timed out connecting to the Murmur realtime gateway."));
        }, 20000);

        socket.addEventListener("message", event => {
          let payload;
          try { payload = JSON.parse(event.data); }
          catch { this.emit("error", new Error("The Murmur API sent invalid JSON.")); return; }

          if (payload.type === "welcome") {
            this.connected = true;
            this.participant = payload.participant;
            this.members = payload.members || [];
            this.history = payload.history || [];
            this._emitEvent(payload);
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(this);
            }
            return;
          }
          this._receive(payload);
        });

        socket.addEventListener("open", () => this.emit("socketOpen", { room: this.room }));
        socket.addEventListener("error", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("Could not establish a WebSocket connection to Murmur."));
          }
        });
        socket.addEventListener("close", event => {
          const wasConnected = this.connected;
          this.connected = false;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("Murmur WebSocket closed before welcome (" + event.code + ")."));
          }
          if (wasConnected) this.emit("disconnected", { reason: "Realtime connection closed.", code: event.code });
          if (!this._closing && this.accessToken) this._scheduleReconnect();
        });
      });
    }

    _scheduleReconnect() {
      if (this._reconnectTimer || this._closing) return;
      this._reconnectTimer = setTimeout(async () => {
        this._reconnectTimer = null;
        if (this._closing || this.connected || !this.accessToken) return;
        try {
          await this._openSocket();
          this.emit("reconnected", { room: this.room });
        } catch (error) {
          this.emit("reconnectError", error);
          this._scheduleReconnect();
        }
      }, 2500);
    }

    async createRoom({ name = "You" } = {}) {
      const data = await this._request("/v1/rooms", {
        method: "POST",
        body: { name }
      });
      this.room = data.roomId;
      this.inviteToken = data.inviteCode;
      this.accessToken = data.accessToken;
      this.participant = data.member;
      this.isHost = true;
      await this._openSocket();
      return { roomId: this.room, inviteToken: this.inviteToken, accessToken: this.accessToken, participant: this.participant };
    }

    async connect({ room, token, name, kind = "agent" }) {
      if (!room || !token || !name) throw new Error("Room ID, invite key and name are required.");
      const data = await this._request("/v1/rooms/" + encodeURIComponent(room) + "/join", {
        method: "POST",
        body: { inviteCode: token, name, kind }
      });
      this.room = data.roomId;
      this.inviteToken = token;
      this.accessToken = data.accessToken;
      this.participant = data.member;
      this.isHost = false;
      await this._openSocket();
      return this;
    }

    _receive(event) {
      if (!event || typeof event.type !== "string") return;
      if (event.type === "message.created" || event.type === "widget.created") {
        if (event.message && !this.history.some(item => item.id === event.message.id)) {
          this.history.push(event.message);
          if (this.history.length > 1000) this.history.shift();
        }
      } else if (event.type === "widget.resolved") {
        const message = this.history.find(item => item.id === event.id);
        if (message?.widget) message.widget.result = event.result;
      } else if (event.type === "progress.updated") {
        const message = this.history.find(item => item.id === event.id);
        if (message?.widget) message.widget.data.percent = event.percent;
      } else if (event.type === "members.updated" || event.type === "presence.changed") {
        this.members = event.members || [];
      } else if (event.type === "member.joined") {
        if (!this.members.some(item => item.id === event.member?.id)) this.members.push(event.member);
      } else if (event.type === "member.left") {
        this.members = this.members.filter(item => item.id !== event.member?.id);
      }
      this._emitEvent(event);
    }

    _submit(event) {
      if (!this.connected || !this.socket || this.socket.readyState !== 1) {
        throw new Error("Not connected to Murmur's realtime API.");
      }
      this.socket.send(JSON.stringify(event));
    }

    sendMessage(text, options = {}) {
      const channel = CHANNELS.has(options.channel) ? options.channel : "general";
      this._submit({ type: "message.send", text, channel, target: options.target || null });
    }

    createWidget(widgetType, data, options = {}) {
      const id = "widget_" + crypto.randomUUID();
      this._submit({ type: "widget.create", id, widgetType, data, channel: options.channel });
      return id;
    }

    respondToWidget(id, result) { this._submit({ type: "widget.respond", id, result }); }
    updateProgress(id, percent) { this._submit({ type: "progress.update", id, percent }); }

    async getHistory({ channel, limit = 100, after = 0 } = {}) {
      const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(200, limit))), after: String(after) });
      if (channel) params.set("channel", channel);
      const result = await this._request("/v1/rooms/" + encodeURIComponent(this.room) + "/messages?" + params);
      this.history = result.messages || this.history;
      return result;
    }

    async getMembers() {
      const result = await this._request("/v1/rooms/" + encodeURIComponent(this.room) + "/members");
      this.members = result.members || [];
      return result;
    }

    async getRoom() {
      return this._request("/v1/rooms/" + encodeURIComponent(this.room));
    }

    async createInvite() {
      if (!this.isHost) throw new Error("Only the room owner can retrieve the invite code.");
      return { inviteToken: this.inviteToken, roomId: this.room };
    }

    waitForMessage({ timeout = 0, predicate = () => true } = {}) {
      return new Promise((resolve, reject) => {
        let timer;
        const off = this.on("message", message => {
          try {
            if (!predicate(message)) return;
            cleanup();
            resolve(message);
          } catch (error) { cleanup(); reject(error); }
        });
        const cleanup = () => { off(); if (timer) clearTimeout(timer); };
        if (timeout > 0) timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
      });
    }

    close() {
      this._closing = true;
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      try { this.socket?.close(1000, "Client closed"); } catch {}
      this.socket = null;
      this.connected = false;
      this.accessToken = null;
      this.emit("closed", {});
    }
  }

  root.MurmurAPIClient = MurmurAPIClient;
  root.createMurmurClient = function () {
    const apiBase = root.MURMUR_CONFIG?.apiBase;
    return apiBase ? new MurmurAPIClient({ apiBase }) : new root.MurmurClient();
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
