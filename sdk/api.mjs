import { EventEmitter } from "node:events";

export class MurmurClient extends EventEmitter {
  constructor({ apiBase = process.env.MURMUR_API_URL || "" } = {}) {
    super();
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.room = null;
    this.accessToken = null;
    this.inviteToken = null;
    this.participant = null;
    this.members = [];
    this.history = [];
    this.connected = false;
    this.socket = null;
    this.isHost = false;
  }

  async request(path, { method = "GET", body } = {}) {
    if (!this.apiBase) throw new Error("Set MURMUR_API_URL.");
    const headers = { accept: "application/json" };
    if (this.accessToken) headers.authorization = "Bearer " + this.accessToken;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(this.apiBase + path, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || ("Murmur API HTTP " + response.status));
    return data;
  }

  openSocket() {
    if (typeof WebSocket !== "function") throw new Error("Node.js 22+ with global WebSocket is required.");
    const url = new URL(this.apiBase + "/v1/rooms/" + encodeURIComponent(this.room) + "/connect");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, ["murmur.v1", "bearer." + this.accessToken]);
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
        try { payload = JSON.parse(String(event.data)); }
        catch { this.emit("error", new Error("Invalid JSON from Murmur.")); return; }
        if (payload.type === "welcome") {
          this.connected = true;
          this.participant = payload.participant;
          this.members = payload.members || [];
          this.history = payload.history || [];
          this.emit("event", payload);
          if (!settled) { settled = true; clearTimeout(timer); resolve(this); }
          return;
        }
        this.receive(payload);
      });
      socket.addEventListener("error", () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Murmur WebSocket connection failed.")); }
      });
      socket.addEventListener("close", event => {
        const active = this.connected;
        this.connected = false;
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Socket closed before welcome (" + event.code + ").")); }
        if (active) this.emit("disconnected", { code: event.code });
      });
    });
  }

  async createRoom({ name = "You" } = {}) {
    const data = await this.request("/v1/rooms", { method: "POST", body: { name } });
    this.room = data.roomId;
    this.inviteToken = data.inviteCode;
    this.accessToken = data.accessToken;
    this.participant = data.member;
    this.isHost = true;
    await this.openSocket();
    return { roomId: this.room, inviteToken: this.inviteToken, accessToken: this.accessToken, participant: this.participant };
  }

  async connect({ room, token, name, kind = "agent" }) {
    const data = await this.request("/v1/rooms/" + encodeURIComponent(room) + "/join", {
      method: "POST", body: { inviteCode: token, name, kind }
    });
    this.room = data.roomId;
    this.inviteToken = token;
    this.accessToken = data.accessToken;
    this.participant = data.member;
    await this.openSocket();
    return this;
  }

  receive(event) {
    if (!event || typeof event.type !== "string") return;
    this.emit("event", event);
    this.emit(event.type, event);
    if (event.type === "message.created" || event.type === "widget.created") {
      if (event.message && !this.history.some(m => m.id === event.message.id)) this.history.push(event.message);
      this.emit(event.type === "message.created" ? "message" : "widget", event.message);
    } else if (event.type === "members.updated" || event.type === "presence.changed") {
      this.members = event.members || [];
      this.emit("members", this.members);
    } else if (event.type === "member.joined") this.emit("memberJoined", event.member);
    else if (event.type === "member.left") this.emit("memberLeft", event.member);
    else if (event.type === "widget.resolved") this.emit("widgetResolved", event);
    else if (event.type === "progress.updated") this.emit("progress", event);
    else if (event.type === "error") this.emit("serverError", event);
  }

  submit(event) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) throw new Error("Not connected to Murmur.");
    this.socket.send(JSON.stringify(event));
  }

  sendMessage(text, options = {}) {
    this.submit({ type: "message.send", text, channel: options.channel || "general", target: options.target || null });
  }
  createWidget(widgetType, data, options = {}) {
    const id = "widget_" + crypto.randomUUID();
    this.submit({ type: "widget.create", id, widgetType, data, channel: options.channel });
    return id;
  }
  respondToWidget(id, result) { this.submit({ type: "widget.respond", id, result }); }
  updateProgress(id, percent) { this.submit({ type: "progress.update", id, percent }); }

  async getHistory({ channel, limit = 100, after = 0 } = {}) {
    const params = new URLSearchParams({ limit: String(limit), after: String(after) });
    if (channel) params.set("channel", channel);
    const data = await this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/messages?" + params);
    this.history = data.messages || this.history;
    return data;
  }
  async getMembers() {
    const data = await this.request("/v1/rooms/" + encodeURIComponent(this.room) + "/members");
    this.members = data.members || [];
    return data;
  }
  async getRoom() { return this.request("/v1/rooms/" + encodeURIComponent(this.room)); }

  waitForMessage({ timeout = 0, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const listener = message => {
        try { if (predicate(message)) { cleanup(); resolve(message); } }
        catch (error) { cleanup(); reject(error); }
      };
      const cleanup = () => { this.off("message", listener); if (timer) clearTimeout(timer); };
      this.on("message", listener);
      if (timeout > 0) timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
    });
  }

  close() {
    try { this.socket?.close(1000, "Client closed"); } catch {}
    this.socket = null;
    this.connected = false;
    this.accessToken = null;
    this.emit("closed");
  }
}
export default MurmurClient;
