/*
 * Murmur P2P SDK — browser build.
 * PeerJS Cloud is used for signaling only. Chat data travels peer-to-peer.
 * Load PeerJS first, then this file.
 */
(function (root) {
  "use strict";

  const CHANNELS = new Set(["general", "ideas", "pending", "orchestrate"]);
  const WIDGET_TYPES = new Set(["approval", "plan", "orchestrate", "choice", "progress"]);
  const MAX_HISTORY = 300;

  function id(prefix = "msg") {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function randomRoomId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return `murmur-${Array.from(bytes, value => (value % 36).toString(36)).join("")}`;
  }

  function randomToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }

  function cleanText(value, max = 4000) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function safeJsonClone(value) {
    return JSON.parse(JSON.stringify(value));
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
      const steps = Array.isArray(data.steps) ? data.steps.slice(0, 20).map(step => cleanText(step, 240)).filter(Boolean) : [];
      if (!title || !steps.length) throw new Error("Plan widgets need a title and at least one step.");
      return { title, steps };
    }
    if (type === "orchestrate") {
      const task = text("task");
      const followers = Array.isArray(data.followers) ? data.followers.slice(0, 10).map(name => cleanText(name, 24)).filter(Boolean) : [];
      if (!task) throw new Error("Orchestration widgets need a task.");
      return { followers, task };
    }
    if (type === "choice") {
      const question = text("question", 500);
      const options = Array.isArray(data.options) ? data.options.slice(0, 8).map(option => cleanText(option, 120)).filter(Boolean) : [];
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
      this.Peer = options.Peer || root.Peer;
      this.peer = null;
      this.hostConnection = null;
      this.connections = new Map();
      this.members = [];
      this.history = [];
      this.listeners = new Map();
      this.room = null;
      this.inviteToken = null;
      this.participant = null;
      this.connected = false;
      this.isHost = false;
      this._closing = false;
    }

    on(eventName, callback) {
      if (typeof callback !== "function") throw new TypeError("Listener must be a function.");
      if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
      this.listeners.get(eventName).add(callback);
      return () => this.off(eventName, callback);
    }

    once(eventName, callback) {
      const off = this.on(eventName, value => { off(); callback(value); });
      return off;
    }

    off(eventName, callback) { this.listeners.get(eventName)?.delete(callback); }

    emit(eventName, value) {
      for (const callback of this.listeners.get(eventName) || []) {
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
      if (event.type === "members.updated") this.emit("members", event.members);
      if (event.type === "error") this.emit("serverError", event);
    }

    _assertPeer() {
      if (typeof this.Peer !== "function") {
        throw new Error("PeerJS didn't load. Check your internet connection and reload Murmur.");
      }
    }

    _openPeer(peerId) {
      this._assertPeer();
      return new Promise((resolve, reject) => {
        let settled = false;
        const peer = peerId ? new this.Peer(peerId) : new this.Peer();
        this.peer = peer;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { peer.destroy(); } catch {}
          reject(new Error("Timed out while connecting to the PeerJS signaling service."));
        }, 20000);
        peer.on("open", assignedId => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(assignedId);
        });
        peer.on("error", error => {
          this.emit("peerError", error);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error);
          }
        });
        peer.on("disconnected", () => {
          if (!this._closing) this.emit("disconnected", { reason: "Lost the PeerJS signaling connection." });
        });
        peer.on("close", () => {
          if (!this._closing && this.connected) {
            this.connected = false;
            this.emit("disconnected", { reason: "Peer connection closed." });
          }
        });
      });
    }

    async createRoom({ roomId, token } = {}) {
      if (this.connected || this.peer) throw new Error("This Murmur client is already in use.");
      this.isHost = true;
      this.room = roomId || randomRoomId();
      this.inviteToken = token || randomToken();
      const assignedId = await this._openPeer(this.room);
      this.room = assignedId;
      this.participant = { id: "owner", name: "You", kind: "human", role: "owner" };
      this.members = [this.participant];
      this.history = this._loadHistory();
      this.peer.on("connection", connection => this._acceptConnection(connection));
      this.connected = true;
      this.emit("connected", { room: this.room, participant: this.participant, isHost: true });
      return { roomId: this.room, inviteToken: this.inviteToken, participant: this.participant };
    }

    async connect({ room, token, name, kind = "agent" }) {
      if (this.connected || this.peer) throw new Error("This Murmur client is already in use.");
      if (!room || !token || !name) throw new Error("Room ID, invite key and name are required.");
      if (!/^[A-Za-z0-9_]{1,24}$/.test(name) || name.toLowerCase() === "you") {
        throw new Error("Names must be 1–24 letters, numbers or underscores, and cannot be You.");
      }
      await this._openPeer();
      this.room = room;
      this.inviteToken = token;
      this.participant = { id: this.peer.id, name, kind: kind === "human" ? "human" : "agent", role: "member" };

      const connection = this.peer.connect(room, { reliable: true, serialization: "json" });
      this.hostConnection = connection;
      return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { connection.close(); this.peer.destroy(); } catch {}
          reject(new Error("The room didn't respond. Check the room ID and make sure its host is online."));
        }, 20000);
        connection.on("open", () => {
          connection.send({ type: "hello", name, token, kind: this.participant.kind, peerId: this.peer.id });
        });
        connection.on("data", event => {
          if (event?.type === "rejected") {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error(event.reason || "The room rejected this connection."));
            }
            return;
          }
          if (event?.type === "welcome") {
            this.connected = true;
            this.participant = event.participant;
            this.members = event.members || [];
            this.history = event.history || [];
            this._emitEvent(event);
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(this);
            }
            return;
          }
          this._receiveEvent(event);
        });
        connection.on("close", () => {
          const wasConnected = this.connected;
          this.connected = false;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("The room connection closed before the welcome message."));
          }
          if (wasConnected) this.emit("disconnected", { reason: "The room host disconnected." });
        });
        connection.on("error", error => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error);
          }
          this.emit("error", error);
        });
      });
    }

    _historyKey() { return `murmur.history.${this.room}`; }

    _loadHistory() {
      try {
        const saved = root.localStorage?.getItem(this._historyKey());
        const items = saved ? JSON.parse(saved) : [];
        return Array.isArray(items) ? items.slice(-MAX_HISTORY) : [];
      } catch { return []; }
    }

    _saveHistory() {
      if (!this.isHost) return;
      try { root.localStorage?.setItem(this._historyKey(), JSON.stringify(this.history.slice(-MAX_HISTORY))); }
      catch (error) { this.emit("storageError", error); }
    }

    _acceptConnection(connection) {
      let member = null;
      connection.on("data", event => {
        if (!member) {
          if (event?.type !== "hello") return;
          const name = cleanText(event.name, 24);
          const validName = /^[A-Za-z0-9_]{1,24}$/.test(name) && name.toLowerCase() !== "you";
          const taken = this.members.some(item => item.name.toLowerCase() === name.toLowerCase());
          if (event.token !== this.inviteToken || !validName || taken) {
            connection.send({ type: "rejected", reason: event.token !== this.inviteToken ? "That invite key is incorrect." : taken ? "That name is already in use." : "Names must be one word and cannot be You." });
            setTimeout(() => connection.close(), 250);
            return;
          }
          member = {
            id: cleanText(event.peerId, 100) || connection.peer,
            name,
            kind: event.kind === "human" ? "human" : "agent",
            role: "member"
          };
          connection.member = member;
          this.connections.set(connection.peer, connection);
          this.members.push(member);
          connection.send({
            type: "welcome",
            room: this.room,
            participant: member,
            members: this.members,
            history: this.history.slice(-MAX_HISTORY)
          });
          this._commitEvent({ type: "member.joined", member });
          this._broadcast({ type: "members.updated", members: this.members });
          this._systemMessage(`${name} joined the room.`);
          return;
        }
        this._handleHostEvent(event, member);
      });
      connection.on("close", () => {
        if (!member) return;
        this.connections.delete(connection.peer);
        this.members = this.members.filter(item => item.id !== member.id);
        this._commitEvent({ type: "member.left", member });
        this._broadcast({ type: "members.updated", members: this.members });
        this._systemMessage(`${member.name} left the room.`);
      });
      connection.on("error", error => this.emit("peerError", error));
    }

    _systemMessage(text) {
      this._commitMessage({
        id: id(), channel: "general", author: "Murmur", text,
        mentions: [], target: null, time: new Date().toISOString(),
        sender: { id: "system", name: "Murmur", kind: "system" }, widget: null
      }, "message.created");
    }

    _handleHostEvent(event, sender) {
      if (!event || typeof event.type !== "string") return;
      if (event.type === "message.send") {
        const text = cleanText(event.text);
        const channel = CHANNELS.has(event.channel) ? event.channel : "general";
        if (!text) return;
        const mentions = [...text.matchAll(/@([A-Za-z0-9_]+)/g)].map(match => match[1]).slice(0, 20);
        const message = {
          id: id(), channel, author: sender.name, text,
          mentions, target: cleanText(event.target, 24) || null,
          time: new Date().toISOString(),
          sender: { id: sender.id, name: sender.name, kind: sender.kind },
          widget: null
        };
        this._commitMessage(message, "message.created");
        return;
      }
      if (event.type === "widget.create") {
        let data;
        try { data = validateWidget(event.widgetType, event.data); }
        catch (error) { this._sendErrorTo(sender.id, error.message); return; }
        // The room assigns the orchestration lead from the accepted connection,
        // rather than trusting a caller-supplied display name.
        if (event.widgetType === "orchestrate") data.lead = sender.name;
        const channel = CHANNELS.has(event.channel) ? event.channel : (event.widgetType === "progress" ? "general" : "pending");
        const message = {
          id: cleanText(event.id, 100) || id("widget"), channel,
          author: sender.name, text: "", mentions: [], target: null,
          time: new Date().toISOString(),
          sender: { id: sender.id, name: sender.name, kind: sender.kind },
          widget: { type: event.widgetType, data, result: null }
        };
        this._commitMessage(message, "widget.created");
        return;
      }
      if (event.type === "widget.respond") {
        const message = this.history.find(item => item.id === event.id && item.widget);
        if (!message || message.widget.type === "progress") return;
        const ownerOnly = ["approval", "plan", "orchestrate"].includes(message.widget.type);
        if (ownerOnly && sender.role !== "owner") {
          this._sendErrorTo(sender.id, "Only the room host can approve or deny this widget.");
          return;
        }
        if (message.widget.type === "choice") {
          const choice = cleanText(event.result?.choice, 120);
          if (!message.widget.data.options.includes(choice)) {
            this._sendErrorTo(sender.id, "That choice is not one of the available options.");
            return;
          }
          message.widget.result = { approved: true, choice };
        } else {
          message.widget.result = {
            approved: event.result?.approved === true,
            ...(Array.isArray(event.result?.steps) ? { steps: event.result.steps.slice(0, 20) } : {})
          };
        }
        this._saveHistory();
        this._commitEvent({ type: "widget.resolved", id: message.id, result: message.widget.result });
        return;
      }
      if (event.type === "progress.update") {
        const message = this.history.find(item => item.id === event.id && item.widget?.type === "progress");
        if (!message || (sender.role !== "owner" && message.sender?.id !== sender.id)) return;
        const percent = Number(event.percent);
        if (!Number.isFinite(percent)) return;
        message.widget.data.percent = Math.max(0, Math.min(100, percent));
        this._saveHistory();
        this._commitEvent({ type: "progress.updated", id: message.id, percent: message.widget.data.percent });
      }
    }

    _sendErrorTo(memberId, message) {
      const connection = this.connections.get(memberId);
      try { connection?.send({ type: "error", error: message }); } catch {}
    }

    _commitMessage(message, eventType) {
      this.history.push(message);
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      this._saveHistory();
      this._commitEvent({ type: eventType, message });
    }

    _commitEvent(event) {
      this._emitEvent(event);
      this._broadcast(event);
    }

    _broadcast(event) {
      for (const connection of this.connections.values()) {
        if (connection.open) {
          try { connection.send(event); } catch (error) { this.emit("peerError", error); }
        }
      }
    }

    _receiveEvent(event) {
      if (!event || typeof event.type !== "string") return;
      if (event.type === "members.updated") this.members = event.members || [];
      if (event.type === "member.joined") this.members.push(event.member);
      if (event.type === "member.left") this.members = this.members.filter(item => item.id !== event.member?.id);
      if (event.type === "message.created" || event.type === "widget.created") {
        if (event.message && !this.history.some(item => item.id === event.message.id)) {
          this.history.push(event.message);
          if (this.history.length > MAX_HISTORY) this.history.shift();
        }
      }
      if (event.type === "widget.resolved") {
        const message = this.history.find(item => item.id === event.id);
        if (message?.widget) message.widget.result = event.result;
      }
      if (event.type === "progress.updated") {
        const message = this.history.find(item => item.id === event.id);
        if (message?.widget) message.widget.data.percent = event.percent;
      }
      if (event.type === "room.closed") {
        this.connected = false;
        this.emit("disconnected", { reason: "The room host closed the room." });
      }
      this._emitEvent(event);
    }

    _submit(event) {
      if (!this.connected) throw new Error("Not connected to a Murmur room.");
      if (this.isHost) this._handleHostEvent(event, this.participant);
      else {
        if (!this.hostConnection?.open) throw new Error("The room host is offline.");
        this.hostConnection.send(event);
      }
    }

    sendMessage(text, options = {}) {
      this._submit({
        type: "message.send",
        channel: options.channel || "general",
        text,
        target: options.target || null
      });
    }

    createWidget(widgetType, data, options = {}) {
      const widgetId = id("widget");
      this._submit({ type: "widget.create", id: widgetId, widgetType, data, channel: options.channel });
      return widgetId;
    }

    respondToWidget(widgetId, result) { this._submit({ type: "widget.respond", id: widgetId, result }); }
    updateProgress(widgetId, percent) { this._submit({ type: "progress.update", id: widgetId, percent }); }

    async getHistory({ channel, limit = 100 } = {}) {
      let messages = this.history;
      if (channel) messages = messages.filter(message => message.channel === channel);
      return { messages: messages.slice(-Math.max(1, Math.min(300, limit))), total: messages.length };
    }

    async getMembers() { return { members: this.members.slice() }; }

    async createInvite() {
      if (!this.isHost) throw new Error("Only the room host can retrieve the invite key.");
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
          } catch (error) { cleanup(); reject(error); }
        });
        const cleanup = () => { off(); if (timer) clearTimeout(timer); };
        if (timeout > 0) timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
      });
    }

    close() {
      this._closing = true;
      if (this.isHost) {
        this._broadcast({ type: "room.closed" });
        for (const connection of this.connections.values()) {
          try { connection.close(); } catch {}
        }
      } else {
        try { this.hostConnection?.close(); } catch {}
      }
      try { this.peer?.destroy(); } catch {}
      this.connections.clear();
      this.connected = false;
      this.peer = null;
      this.emit("closed", {});
    }
  }

  root.MurmurClient = MurmurClient;
  root.Murmur = Object.freeze({ version: "1.0.0-p2p", createClient: options => new MurmurClient(options) });
})(typeof globalThis !== "undefined" ? globalThis : window);
