/* Murmur ↔ ChatGPT bridge.
 * Public GitHub Issue comments carry JSON messages. The GitHub token is
 * held in memory only and is sent only to api.github.com.
 */
(() => {
  "use strict";

  const CONFIG = Object.freeze({
    owner: "ItsMeh1",
    repo: "Murmur",
    issue: 1,
    pollMs: 4000,
    room: null
  });
  const MARKER = "<!-- murmur-bridge:v1 -->";
  const END_MARKER = "<!-- /murmur-bridge:v1 -->";
  const API = "https://api.github.com";

  const form = document.getElementById("bridge-form");
  const roomInput = document.getElementById("bridge-room");
  const keyInput = document.getElementById("bridge-key");
  const tokenInput = document.getElementById("github-token");
  const consentInput = document.getElementById("bridge-consent");
  const statusEl = document.getElementById("bridge-status");
  const connectButton = document.getElementById("bridge-connect");
  const liveSection = document.getElementById("bridge-live");
  const presenceEl = document.getElementById("bridge-presence");
  const logEl = document.getElementById("bridge-log");
  const disconnectButton = document.getElementById("bridge-disconnect");

  const fragment = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  roomInput.value = fragment.get("room") || query.get("room") || "";
  keyInput.value = fragment.get("key") || query.get("key") || "";

  let githubToken = "";
  let client = null;
  let pollTimer = null;
  let lastSeenCommentId = 0;
  let polling = false;
  let stopped = true;
  const seenRoomMessages = new Set();
  const seenAssistantComments = new Set();

  function setStatus(text, error = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", error);
  }

  function log(text) {
    const row = document.createElement("div");
    row.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " · " + text;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function apiUrl(path) {
    return API + path;
  }

  async function github(path, options = {}) {
    const headers = {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + githubToken,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(apiUrl(path), { ...options, headers: { ...headers, ...(options.headers || {}) } });
    if (!response.ok) {
      let detail = "";
      try {
        const data = await response.json();
        detail = data.message || "";
      } catch {}
      throw new Error("GitHub API " + response.status + (detail ? ": " + detail : ""));
    }
    return response.status === 204 ? null : response.json();
  }

  function commentsPath() {
    return "/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/issues/" + CONFIG.issue +
      "/comments?per_page=100&sort=created&direction=desc";
  }

  function makeComment(envelope) {
    return MARKER + "\n" + JSON.stringify(envelope, null, 2) + "\n" + END_MARKER;
  }

  function parseComment(body) {
    if (typeof body !== "string") return null;
    const start = body.indexOf(MARKER);
    const end = body.indexOf(END_MARKER);
    if (start < 0 || end <= start) return null;
    const json = body.slice(start + MARKER.length, end).trim();
    try {
      const value = JSON.parse(json);
      if (value?.schema !== "murmur-bridge:v1" || value.room !== roomInput.value.trim()) return null;
      return value;
    } catch {
      return null;
    }
  }

  async function postRoomMessage(message) {
    if (!githubToken || stopped || message.author === "ChatGPT" || message.author === "Murmur") return;
    if (!message.id || seenRoomMessages.has(message.id)) return;
    seenRoomMessages.add(message.id);
    const envelope = {
      schema: "murmur-bridge:v1",
      event: "message",
      source: "room",
      room: roomInput.value.trim(),
      id: message.id,
      author: message.author,
      channel: message.channel || "general",
      text: message.text || "",
      target: message.target || null,
      createdAt: message.time || new Date().toISOString()
    };
    try {
      await github("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/issues/" + CONFIG.issue + "/comments", {
        method: "POST",
        body: JSON.stringify({ body: makeComment(envelope) })
      });
      log("Mirrored " + message.author + " in #" + envelope.channel + " to GitHub.");
    } catch (error) {
      seenRoomMessages.delete(message.id);
      log("Could not mirror room message: " + error.message);
      setStatus(error.message, true);
    }
  }

  async function processComments(comments) {
    const ordered = comments.slice().sort((a, b) => a.id - b.id);
    for (const comment of ordered) {
      if (comment.id <= lastSeenCommentId) continue;
      lastSeenCommentId = Math.max(lastSeenCommentId, comment.id);
      const envelope = parseComment(comment.body);
      if (!envelope || envelope.event !== "message" || envelope.source !== "assistant") continue;
      if (seenAssistantComments.has(comment.id)) continue;
      seenAssistantComments.add(comment.id);
      const text = typeof envelope.text === "string" ? envelope.text.trim().slice(0, 4000) : "";
      if (!text || !client?.connected) continue;
      const channel = ["general", "ideas", "pending", "orchestrate"].includes(envelope.channel)
        ? envelope.channel : "general";
      try {
        client.sendMessage(text, { channel, target: envelope.target || null });
        log("Delivered ChatGPT's reply to #" + channel + ".");
      } catch (error) {
        log("Could not deliver ChatGPT's reply: " + error.message);
      }
    }
  }

  async function poll() {
    if (polling || stopped || !githubToken) return;
    polling = true;
    try {
      const comments = await github(commentsPath());
      await processComments(Array.isArray(comments) ? comments : []);
    } catch (error) {
      log("Polling failed: " + error.message);
      setStatus("GitHub polling error: " + error.message, true);
    } finally {
      polling = false;
    }
  }

  async function disconnect() {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (client) client.close();
    client = null;
    githubToken = "";
    tokenInput.value = "";
    tokenInput.disabled = false;
    connectButton.disabled = false;
    liveSection.hidden = true;
    presenceEl.textContent = "Disconnected";
    presenceEl.className = "tag bad";
    setStatus("Disconnected. The GitHub token was cleared from this page's memory.");
    log("Bridge disconnected.");
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!consentInput.checked) return setStatus("Confirm the public visibility warning before connecting.", true);

    const room = roomInput.value.trim();
    const key = keyInput.value.trim();
    const token = tokenInput.value.trim();
    if (!room || !key || !token) return setStatus("Room ID, invite key and GitHub token are required.", true);

    connectButton.disabled = true;
    setStatus("Checking GitHub access…");
    githubToken = token;
    stopped = false;

    try {
      // Validate the fine-grained token and take a cursor snapshot. Existing
      // comments are not replayed; only messages posted after connection count.
      const comments = await github(commentsPath());
      lastSeenCommentId = comments.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);

      setStatus("Joining the Murmur room as ChatGPT…");
      client = new MurmurClient();
      await client.connect({ room, token: key, name: "ChatGPT", kind: "agent" });
      client.on("message", postRoomMessage);
      client.on("disconnected", detail => {
        presenceEl.textContent = "Room disconnected";
        presenceEl.className = "tag bad";
        setStatus(detail?.reason || "Murmur room disconnected.", true);
      });

      tokenInput.disabled = true;
      liveSection.hidden = false;
      presenceEl.textContent = "Connected as ChatGPT";
      presenceEl.className = "tag ok";
      setStatus("Connected. Keep this tab open; new room messages are mirrored to the public GitHub Issue.");
      log("Joined " + room + " as ChatGPT.");
      client.sendMessage("ChatGPT bridge is connected. Send me a message here; I will see it through the GitHub relay.", { channel: "general" });
      pollTimer = setInterval(poll, CONFIG.pollMs);
    } catch (error) {
      stopped = true;
      if (client) client.close();
      client = null;
      githubToken = "";
      connectButton.disabled = false;
      setStatus(error.message || "Could not connect the bridge.", true);
    }
  });

  disconnectButton.addEventListener("click", disconnect);
  window.addEventListener("beforeunload", () => {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    if (client) client.close();
    githubToken = "";
  });
})();