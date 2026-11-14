const params = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.slice(1));
const roomInput = document.getElementById("agent-room");
const tokenInput = document.getElementById("agent-token");
const nameInput = document.getElementById("agent-name");
const statusEl = document.getElementById("agent-status");
const connectButton = document.getElementById("agent-connect-btn");
const chatEl = document.getElementById("agent-chat");
const logEl = document.getElementById("agent-log");
const messageInput = document.getElementById("agent-message");
const onlineEl = document.getElementById("agent-online");

roomInput.value = fragment.get("room") || params.get("room") || "";
tokenInput.value = fragment.get("key") || params.get("key") || params.get("invite") || "";
nameInput.value = params.get("name") || "Scout";

let client = null;

function setStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", error);
}

function logMessage(author, text, time = new Date()) {
  const row = document.createElement("div");
  row.className = "agent-log-message";
  const header = document.createElement("div");
  header.className = "row";
  const name = document.createElement("strong");
  name.textContent = author;
  const timestamp = document.createElement("small");
  timestamp.textContent = new Date(time || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  header.append(name, timestamp);
  const body = document.createElement("div");
  body.textContent = text;
  row.append(header, body);
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderHistory(messages) {
  logEl.replaceChildren();
  for (const message of messages) {
    const text = message.widget ? `[${message.widget.type} widget]` : message.text;
    logMessage(message.author, text || "", message.time);
  }
}

document.getElementById("agent-connect-form").addEventListener("submit", async event => {
  event.preventDefault();
  const room = roomInput.value.trim();
  const token = tokenInput.value.trim();
  const name = nameInput.value.trim();
  if (!room || !token || !name) return setStatus("Enter the room ID, invite key and agent name.", true);

  connectButton.disabled = true;
  setStatus("Connecting to Murmur…");
  try {
    client?.close();
    client = createMurmurClient();
    client.on("message", message => logMessage(message.author, message.text, message.createdAt || message.time));
    client.on("widget", message => logMessage(message.author, `[${message.widget.type} widget]`, message.createdAt || message.time));
    client.on("disconnected", detail => {
      onlineEl.textContent = "Disconnected";
      onlineEl.className = "tag bad";
      setStatus(detail?.reason || "Disconnected from the room.", true);
    });
    client.on("serverError", error => logMessage("Murmur", error.error || "Room error"));

    await client.connect({ room, token, name, kind: "agent" });
    const history = await client.getHistory({ limit: 300 });
    renderHistory(history.messages || []);
    document.getElementById("agent-identity").textContent = `${name} · ${room}`;
    chatEl.hidden = false;
    setStatus("Connected to the shared Murmur room.");
    onlineEl.textContent = "Connected";
    onlineEl.className = "tag ok";
  } catch (error) {
    setStatus(error.message || "Could not connect.", true);
    onlineEl.textContent = "Offline";
    onlineEl.className = "tag bad";
  } finally {
    connectButton.disabled = false;
  }
});

document.getElementById("agent-send-form").addEventListener("submit", event => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !client?.connected) return;
  try {
    client.sendMessage(text, { channel: "general" });
    messageInput.value = "";
  } catch (error) {
    logMessage("Murmur", error.message);
  }
});

window.addEventListener("beforeunload", () => client?.close());
