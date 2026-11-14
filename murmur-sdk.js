/*
 * Murmur HTTP/JSON SDK v1
 *
 * Provider adapter: Firebase Realtime Database REST + optional SSE.
 * Protocol clients use ordinary JSON events and HTTP. The SDK is convenience;
 * any language can call the documented endpoints without this file.
 */
(function (root) {
  "use strict";

  const CHANNELS = new Set(["general", "ideas", "pending", "orchestrate"]);
  const WIDGET_TYPES = new Set(["approval", "plan", "orchestrate", "choice", "progress"]);
  const MAX_HISTORY = 300;
  const AUTH_STORAGE_PREFIX = "murmur.auth.v1.";

  function randomHex(bytes = 24) {
    const values = new Uint8Array(bytes);
    root.crypto.getRandomValues(values);
    return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
  }

  function makeId(prefix) {
    return prefix + "_" + Date.now().toString(36) + "_" + randomHex(10);
  }

  function makeRoomId() {
    return "murmur-" + randomHex(5);
  }

  function cleanText(value, max = 4000) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function validateWidget(type, data) {
    if (!WIDGET_TYPES.has(type) || !data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid widget type or data.");
    }
    const text = (key, max = 2000) => cleanText(data[key], max);
    if (type === "approval") {
      const title = text("title", 120);
      if (!title) throw new Error("Approval widgets need a title.");
      return { title, details: text("details"), action: text("action", 1000) };
    }
    if (type === "plan") {
      const title = text("title", 120);
      const steps = Array.isArray(data.steps)
        ? data.steps.slice(0, 20).map(step => cleanText(step, 240)).filter(Boolean)
        : [];
      if (!title || !steps.length) throw new Error("Plan widgets need a title and at least one step.");
      return { title, steps };
    }
    if (type === "orchestrate") {
      const task = text("task");
      const followers = Array.isArray(data.followers)
        ? data.followers.slice(0, 10).map(name => cleanText(name, 24)).filter(Boolean)
        : [];
      if (!task) throw new Error("Orchestration widgets need a task.");
      return { task, followers };
    }
    if (type === "choice") {
      const question = text("question", 500);
      const options = Array.isArray(data.options)
        ? data.options.slice(0, 8).map(option => cleanText(option, 120)).filter(Boolean)
        : [];
      if (!question || options.length < 2) throw new Error("Choice widgets need a question and at least two options.");
      return { question, options };
    }
    const label = text("label", 120);
    const percent = Number(data.percent);
    if (!label || !Number.isFinite(percent)) throw new Error("Progress widgets need a label and percentage.");
    return { label, percent: Math.max(0, Math.min(100, percent)) };
  }

  class MurmurClient {
    constructor(options = {}) {
      const config = options.config || root.MURMUR_CONFIG || {};
      this.apiKey = options.apiKey || config.apiKey || "";
      this.databaseURL = String(options.databaseURL || config.databaseURL || "").replace(/\/+$/, "");
      this.fetch = options.fetch || (root.fetch && root.fetch.bind(root));
      this.EventSource = options.EventSource || root.EventSource || null;
      this.storage = options.storage === undefined ? (root.sessionStorage || null) : options.storage;
      this.pollIntervalMs = Math.max(1000, Number(options.pollIntervalMs) || 2500);

      this.room = null;
      this.inviteToken = null;
      this.accessToken = null;
      this.participant = null;
      this.members = [];
      this.history = [];
      this.connected = false;
      this.isHost = false;

      this.listeners = new Map();
      this._auth = null;
      this._events = new Map();
      this._stream = null;
      this._pollTimer = null;
      this._heartbeatTimer = null;
      this._polling = false;
      this._closing = false;
      this._storageKey = this.databaseURL
        ? AUTH_STORAGE_PREFIX + this.databaseURL.replace(/^https?:\/\//, "").replace(/[^a-z0-9]/gi, "_")
        : AUTH_STORAGE_PREFIX + "default";
    }

    on(name, callback) {
      if (typeof callback !== "function") throw new TypeError("Listener must be a function.");
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
      return () => this.off(name, callback);
    }

    once(name, callback) {
      let off;
      off = this.on(name, value => { off(); callback(value); });
      return off;
    }

    off(name, callback) {
      this.listeners.get(name)?.delete(callback);
    }

    emit(name, value) {
      for (const callback of this.listeners.get(name) || []) {
        try { callback(value); }
        catch (error) { setTimeout(() => { throw error; }, 0); }
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
        if (event.members) this.members = event.members;
        this.emit("members", this.members);
      }
      if (event.type === "error") this.emit("serverError", event);
    }

    _assertConfig() {
      if (!this.fetch) throw new Error("This environment does not provide fetch().");
      if (!this.apiKey || !this.databaseURL) {
        throw new Error("Murmur is not configured yet. Add your Firebase Web API key and Realtime Database URL to murmur-config.js. See docs/FIREBASE-SETUP.md.");
      }
    }

    _readStoredAuth() {
      try {
        const raw = this.storage?.getItem(this._storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    _saveAuth() {
      try {
        if (this._auth) this.storage?.setItem(this._storageKey, JSON.stringify(this._auth));
      } catch {}
    }

    async _authRequest(url, body, formEncoded = false) {
      const response = await this.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": formEncoded ? "application/x-www-form-urlencoded" : "application/json"
        },
        body: formEncoded ? body : JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data?.error?.message || data?.error || ("HTTP " + response.status);
        throw new Error("Firebase Authentication: " + message);
      }
      return data;
    }

    async _authenticate(forceRefresh = false) {
      this._assertConfig();
      if (!this._auth) this._auth = this._readStoredAuth() || null;
      const now = Date.now();

      if (!forceRefresh && this._auth?.idToken && Number(this._auth.expiresAt) > now + 60000) {
        this.accessToken = this._auth.idToken;
        return this._auth;
      }

      if (this._auth?.refreshToken) {
        try {
          const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this._auth.refreshToken
          }).toString();
          const refreshed = await this._authRequest(
            "https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(this.apiKey),
            body,
            true
          );
          this._auth = {
            uid: refreshed.user_id || this._auth.uid,
            idToken: refreshed.id_token,
            refreshToken: refreshed.refresh_token || this._auth.refreshToken,
            expiresAt: now + Math.max(60, Number(refreshed.expires_in) || 3600) * 1000
          };
          this.accessToken = this._auth.idToken;
          this._saveAuth();
          return this._auth;
        } catch (error) {
          this._auth = null;
          try { this.storage?.removeItem(this._storageKey); } catch {}
          if (forceRefresh) throw error;
        }
      }

      const created = await this._authRequest(
        "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + encodeURIComponent(this.apiKey),
        { returnSecureToken: true }
      );
      this._auth = {
        uid: created.localId,
        idToken: created.idToken,
        refreshToken: created.refreshToken,
        expiresAt: now + Math.max(60, Number(created.expiresIn) || 3600) * 1000
      };
      this.accessToken = this._auth.idToken;
      this._saveAuth();
      return this._auth;
    }

    _databasePath(path) {
      return path.split("/").filter(Boolean).map(segment => encodeURIComponent(segment)).join("/");
    }

    async _databaseRequest(path, options = {}, retried = false) {
      const auth = await this._authenticate();
      const url = new URL(this.databaseURL + "/" + this._databasePath(path) + ".json");
      url.searchParams.set("auth", auth.idToken);
      for (const [key, value] of Object.entries(options.query || {})) {
        url.searchParams.set(key, String(value));
      }

      const response = await this.fetch(url.toString(), {
        method: options.method || "GET",
        headers: options.body === undefined ? { Accept: "application/json" } : {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      });
      const data = await response.json().catch(() => null);

      if (response.status === 401 && !retried) {
        await this._authenticate(true);
        return this._databaseRequest(path, options, true);
      }
      if (!response.ok) {
        const message = typeof data === "string" ? data : data?.error || data?.message || ("HTTP " + response.status);
        throw new Error("Murmur database: " + message);
      }
      return data;
    }

    _eventStreamUrl() {
      const url = new URL(this.databaseURL + "/rooms/" + this._databasePath(this.room) + "/events.json");
      url.searchParams.set("auth", this.accessToken);
      url.searchParams.set("orderBy", '"createdAt"');
      url.searchParams.set("limitToLast", String(MAX_HISTORY));
      return url.toString();
    }

    async createRoom(options = {}) {
      if (this.connected) throw new Error("This client is already connected.");
      if (options.roomId && options.token) {
        await this.connect({
          room: options.roomId,
          token: options.token,
          name: options.name || "You",
          kind: "human"
        });
        if (!this.isHost) throw new Error("That saved room does not belong to this account.");
        return {
          roomId: this.room,
          inviteToken: this.inviteToken,
          participant: this.participant
        };
      }

      const auth = await this._authenticate();
      const roomId = makeRoomId();
      const inviteToken = randomHex(32);
      const owner = {
        uid: auth.uid,
        name: options.name || "You",
        kind: "human",
        role: "owner"
      };
      const timestamp = { ".sv": "timestamp" };
      const roomData = {
        meta: {
          roomId,
          protocol: "murmur.http.v1",
          ownerUid: auth.uid,
          ownerName: owner.name,
          createdAt: timestamp
        },
        private: { inviteKey: inviteToken },
        members: {
          [auth.uid]: { inviteProof: inviteToken, joinedAt: timestamp }
        },
        roster: {
          [auth.uid]: { ...owner, joinedAt: timestamp }
        },
        events: {}
      };

      await this._databaseRequest("rooms/" + roomId, { method: "PUT", body: roomData });
      this.room = roomId;
      this.inviteToken = inviteToken;
      this.participant = owner;
      this.isHost = true;
      this.connected = true;
      this._startEvents();
      this._startHeartbeat();
      this.members = [owner];
      this.emit("connected", { room: roomId, participant: owner, isHost: true });
      this._emitEvent({ type: "members.updated", members: this.members });
      return { roomId, inviteToken, participant: owner };
    }

    async connect({ room, token, name, kind = "agent" }) {
      if (this.connected) throw new Error("This client is already connected.");
      if (!room || !token || !name) throw new Error("Room ID, invite key and name are required.");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(room)) throw new Error("Invalid room ID.");
      if (!/^[A-Za-z0-9_]{1,24}$/.test(name) || name.toLowerCase() === "you") {
        throw new Error("Names must be 1–24 letters, numbers or underscores, and cannot be You.");
      }

      const auth = await this._authenticate();
      this.room = room;
      this.inviteToken = token;

      const proof = { inviteProof: token, joinedAt: { ".sv": "timestamp" } };
      await this._databaseRequest("rooms/" + room + "/members/" + auth.uid, {
        method: "PUT",
        body: proof
      });

      const meta = await this._databaseRequest("rooms/" + room + "/meta");
      if (!meta) throw new Error("That Murmur room does not exist.");
      const existing = await this._databaseRequest("rooms/" + room + "/roster/" + auth.uid);
      if (existing && existing.name !== name) {
        throw new Error("This browser identity already belongs to the participant " + existing.name + ".");
      }

      const role = meta.ownerUid === auth.uid ? "owner" : "member";
      const profile = existing || {
        uid: auth.uid,
        name,
        kind: kind === "human" ? "human" : "agent",
        role,
        joinedAt: Date.now()
      };
      if (!existing) {
        await this._databaseRequest("rooms/" + room + "/roster/" + auth.uid, {
          method: "PUT",
          body: profile
        });
      }

      this.participant = profile;
      this.isHost = profile.role === "owner";
      this.connected = true;
      this.members = (await this.getMembers()).members;
      this.history = (await this.getHistory({ limit: MAX_HISTORY })).messages;

      this._startEvents();
      this._startHeartbeat();
      if (!existing) {
        await this._writeEvent("member.joined", { member: profile });
      }
      this.emit("connected", { room, participant: profile, isHost: this.isHost });
      this._emitEvent({ type: "members.updated", members: this.members });
      return this;
    }

    async _writePresence(online) {
      if (!this.connected || !this.participant?.uid) return;
      try {
        await this._databaseRequest("rooms/" + this.room + "/presence/" + this.participant.uid, {
          method: "PUT",
          body: { online: Boolean(online), lastSeen: { ".sv": "timestamp" } }
        });
      } catch (error) {
        this.emit("serverError", { error: error.message });
      }
    }

    _startHeartbeat() {
      this._writePresence(true);
      this._heartbeatTimer = setInterval(() => this._writePresence(true), 25000);
    }

    _stopEvents() {
      if (this._stream) {
        try { this._stream.close(); } catch {}
        this._stream = null;
      }
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
    }

    _startEvents() {
      this._stopEvents();
      this._closing = false;

      if (this.EventSource) {
        try {
          const stream = new this.EventSource(this._eventStreamUrl());
          this._stream = stream;
          const handle = event => {
            try {
              const payload = JSON.parse(event.data);
              this._applyStreamPayload(payload);
            } catch (error) {
              this.emit("serverError", { error: "Invalid event stream payload: " + error.message });
            }
          };
          stream.addEventListener("put", handle);
          stream.addEventListener("patch", handle);
          stream.onerror = () => {
            if (this._closing || this._stream !== stream) return;
            try { stream.close(); } catch {}
            this._stream = null;
            this.emit("transportFallback", { transport: "http-polling" });
            this._startPolling();
          };
          return;
        } catch (error) {
          this.emit("transportFallback", { transport: "http-polling", reason: error.message });
        }
      }
      this._startPolling();
    }

    _applyStreamPayload(payload) {
      if (!payload || typeof payload !== "object") return;
      const path = String(payload.path || "/");
      const data = payload.data;
      if (path === "/" || path === "") {
        if (data && typeof data === "object") {
          for (const value of Object.values(data)) this._consumeEnvelope(value);
        }
        return;
      }
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 1) this._consumeEnvelope(data);
    }

    _startPolling() {
      if (this._pollTimer || this._closing) return;
      const poll = async () => {
        if (this._polling || !this.connected || this._closing) return;
        this._polling = true;
        try {
          const snapshot = await this._readEventSnapshot(MAX_HISTORY);
          for (const event of this._sortEvents(snapshot)) this._consumeEnvelope(event);
        } catch (error) {
          this.emit("serverError", { error: error.message });
        } finally {
          this._polling = false;
        }
      };
      poll();
      this._pollTimer = setInterval(poll, this.pollIntervalMs);
    }

    async _readEventSnapshot(limit = MAX_HISTORY) {
      return this._databaseRequest("rooms/" + this.room + "/events", {
        query: { orderBy: '"createdAt"', limitToLast: Math.max(1, Math.min(MAX_HISTORY, limit)) }
      });
    }

    _sortEvents(snapshot) {
      if (!snapshot || typeof snapshot !== "object") return [];
      return Object.values(snapshot)
        .filter(item => item && typeof item === "object" && typeof item.type === "string")
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    }

    _messageFromEnvelope(envelope) {
      const sender = envelope.sender || {};
      const data = envelope.data || {};
      if (envelope.type === "message.created") {
        return {
          id: envelope.id,
          channel: CHANNELS.has(data.channel) ? data.channel : "general",
          author: sender.name || "Unknown",
          text: cleanText(data.text),
          mentions: Array.isArray(data.mentions) ? data.mentions : [],
          target: data.target || null,
          time: new Date(Number(envelope.createdAt) || Date.now()).toISOString(),
          sender: { id: sender.uid, name: sender.name, kind: sender.kind },
          widget: null
        };
      }
      if (envelope.type === "widget.created") {
        return {
          id: envelope.id,
          channel: CHANNELS.has(data.channel) ? data.channel : (data.widgetType === "progress" ? "general" : "pending"),
          author: sender.name || "Unknown",
          text: "",
          mentions: [],
          target: null,
          time: new Date(Number(envelope.createdAt) || Date.now()).toISOString(),
          sender: { id: sender.uid, name: sender.name, kind: sender.kind },
          widget: { type: data.widgetType, data: data.widgetData || {}, result: null }
        };
      }
      return null;
    }

    _consumeEnvelope(envelope) {
      if (!envelope || !envelope.id || !envelope.type || this._events.has(envelope.id)) return;
      this._events.set(envelope.id, envelope);
      if (this._events.size > MAX_HISTORY * 2) {
        const oldest = this._events.keys().next().value;
        this._events.delete(oldest);
      }

      if (envelope.type === "message.created" || envelope.type === "widget.created") {
        const message = this._messageFromEnvelope(envelope);
        if (!message) return;
        this.history.push(message);
        if (this.history.length > MAX_HISTORY) this.history.shift();
        this._emitEvent({ type: envelope.type, message });
        return;
      }
      if (envelope.type === "widget.resolved") {
        const widgetId = envelope.data?.widgetId;
        const result = envelope.data?.result || {};
        const message = this.history.find(item => item.id === widgetId);
        if (message?.widget) message.widget.result = result;
        this._emitEvent({ type: "widget.resolved", id: widgetId, result });
        return;
      }
      if (envelope.type === "progress.updated") {
        const widgetId = envelope.data?.widgetId;
        const percent = Number(envelope.data?.percent);
        const message = this.history.find(item => item.id === widgetId);
        if (message?.widget) message.widget.data.percent = percent;
        this._emitEvent({ type: "progress.updated", id: widgetId, percent });
        return;
      }
      if (envelope.type === "member.joined" || envelope.type === "member.left") {
        const member = envelope.data?.member;
        this._emitEvent({ type: envelope.type, member });
      }
    }

    async _writeEvent(type, data) {
      if (!this.connected || !this.participant?.uid) throw new Error("Not connected to a Murmur room.");
      const id = makeId("evt");
      const envelope = {
        id,
        roomId: this.room,
        type,
        senderUid: this.participant.uid,
        sender: {
          uid: this.participant.uid,
          name: this.participant.name,
          kind: this.participant.kind,
          role: this.participant.role
        },
        createdAt: { ".sv": "timestamp" },
        data
      };
      await this._databaseRequest("rooms/" + this.room + "/events/" + id, {
        method: "PUT",
        body: envelope
      });
      this._consumeEnvelope({ ...envelope, createdAt: Date.now() });
      return id;
    }

    async sendMessage(text, options = {}) {
      const body = cleanText(text);
      if (!body) throw new Error("Message cannot be empty.");
      const channel = CHANNELS.has(options.channel) ? options.channel : "general";
      return this._writeEvent("message.created", {
        channel,
        text: body,
        target: cleanText(options.target, 24) || null,
        mentions: [...body.matchAll(/@([A-Za-z0-9_]+)/g)].map(match => match[1]).slice(0, 20)
      });
    }

    async createWidget(widgetType, data, options = {}) {
      const widgetData = validateWidget(widgetType, data);
      if (widgetType === "orchestrate") widgetData.lead = this.participant?.name || "Unknown";
      const channel = CHANNELS.has(options.channel)
        ? options.channel
        : (widgetType === "progress" ? "general" : "pending");
      return this._writeEvent("widget.created", { widgetType, widgetData, channel });
    }

    async respondToWidget(widgetId, result) {
      const widget = this.history.find(item => item.id === widgetId && item.widget);
      if (!widget) throw new Error("Widget not found in recent room history.");
      if (["approval", "plan", "orchestrate"].includes(widget.widget.type) && !this.isHost) {
        throw new Error("Only the room owner can resolve this widget.");
      }
      if (widget.widget.type === "choice" && !widget.widget.data.options.includes(result?.choice)) {
        throw new Error("Choose one of the options shown in the widget.");
      }
      return this._writeEvent("widget.resolved", { widgetId, result: result || {} });
    }

    async updateProgress(widgetId, percent) {
      const widget = this.history.find(item => item.id === widgetId && item.widget?.type === "progress");
      if (!widget) throw new Error("Progress widget not found.");
      if (!this.isHost && widget.sender?.id !== this.participant?.uid) {
        throw new Error("Only the widget creator or room owner can update progress.");
      }
      return this._writeEvent("progress.updated", {
        widgetId,
        percent: Math.max(0, Math.min(100, Number(percent) || 0))
      });
    }

    async getHistory({ channel, limit = 100 } = {}) {
      if (!this.room) throw new Error("Join a room first.");
      const snapshot = await this._readEventSnapshot(MAX_HISTORY);
      const events = this._sortEvents(snapshot);
      const messages = [];
      for (const event of events) {
        if (event.type === "message.created" || event.type === "widget.created") {
          const message = this._messageFromEnvelope(event);
          if (message) messages.push(message);
        } else if (event.type === "widget.resolved") {
          const item = messages.find(message => message.id === event.data?.widgetId);
          if (item?.widget) item.widget.result = event.data.result || {};
        } else if (event.type === "progress.updated") {
          const item = messages.find(message => message.id === event.data?.widgetId);
          if (item?.widget) item.widget.data.percent = Number(event.data.percent) || 0;
        }
      }
      this.history = messages.slice(-MAX_HISTORY);
      for (const event of events) if (event.id) this._events.set(event.id, event);
      let filtered = this.history;
      if (channel) filtered = filtered.filter(message => message.channel === channel);
      const safeLimit = Math.max(1, Math.min(MAX_HISTORY, Number(limit) || 100));
      return { messages: filtered.slice(-safeLimit), total: filtered.length };
    }

    async getMembers() {
      if (!this.room) throw new Error("Join a room first.");
      const [roster, presence] = await Promise.all([
        this._databaseRequest("rooms/" + this.room + "/roster"),
        this._databaseRequest("rooms/" + this.room + "/presence").catch(() => ({}))
      ]);
      const now = Date.now();
      const members = Object.entries(roster || {}).map(([uid, member]) => {
        const p = presence?.[uid] || {};
        const lastSeen = Number(p.lastSeen) || 0;
        return {
          ...member,
          id: uid,
          online: p.online === true && now - lastSeen < 65000,
          lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null
        };
      });
      this.members = members;
      return { members };
    }

    async getRoom() {
      if (!this.room) throw new Error("Join a room first.");
      const meta = await this._databaseRequest("rooms/" + this.room + "/meta");
      return { room: meta, participant: this.participant };
    }

    async createInvite() {
      if (!this.isHost) throw new Error("Only the room owner can retrieve the invite key.");
      return { inviteToken: this.inviteToken, roomId: this.room };
    }

    waitForMessage({ timeout = 0, predicate = () => true } = {}) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const off = this.on("message", message => {
          try {
            if (!predicate(message)) return;
            cleanup();
            resolve(message);
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
        const cleanup = () => {
          off();
          if (timer) clearTimeout(timer);
        };
        if (timeout > 0) timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
      });
    }

    async endRoom() {
      if (!this.isHost) throw new Error("Only the room owner can end this room.");
      await this._databaseRequest("rooms/" + this.room, { method: "DELETE" });
      this.close();
    }

    close() {
      if (this._closing) return;
      this._closing = true;
      this._stopEvents();
      if (this._heartbeatTimer) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
      if (this.connected && this.participant?.uid) {
        this._databaseRequest("rooms/" + this.room + "/presence/" + this.participant.uid, {
          method: "PUT",
          body: { online: false, lastSeen: { ".sv": "timestamp" } }
        }).catch(() => {});
        this._writeEvent("member.left", { member: this.participant }).catch(() => {});
      }
      this.connected = false;
      this.emit("closed", {});
    }
  }

  root.MurmurClient = MurmurClient;
  root.Murmur = Object.freeze({
    version: "1.0.0-http-json",
    createClient: options => new MurmurClient(options)
  });
  root.createMurmurClient = options => new MurmurClient(options);
})(typeof globalThis !== "undefined" ? globalThis : window);
