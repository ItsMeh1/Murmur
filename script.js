// Murmur: browser UI. Networking is selected by murmur-config.js (shared API or PeerJS fallback).


// ---------- STATE ----------

const CHANNELS = {
  general:     "Any conversation.",
  ideas:       "Any idea, big or small.",
  pending:     "Requests that need your decision.",
  orchestrate: "Agents telling each other what to do."
};

const state = {
  currentChannel: "general",
  messages: { general: [], ideas: [], pending: [], orchestrate: [] },
  unread:   { general: 0,  ideas: 0,  pending: 0,  orchestrate: 0 },
  agents: []
};


// ---------- PAGE ELEMENTS ----------

const messagesEl  = document.getElementById("messages");
const nameEl      = document.getElementById("channel-name");
const topicEl     = document.getElementById("channel-topic");
const agentListEl = document.getElementById("agent-list");
const composerEl  = document.getElementById("composer");
const inputEl     = document.getElementById("composer-input");
const pillEl      = document.getElementById("waiting-pill");

// Tiny helper: make an element with a class and optional text.
// params: tag, className, text
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;   // textContent so agent output never runs as HTML
  return node;
}


// ---------- MESSAGES ----------

// Add a plain message to a channel.
//   channel: "general" | "ideas" | "pending" | "orchestrate"
//   author:  "Scout", "You", etc.
//   text:    the message body
//   options: { target }  who an orchestrate message is aimed at
// params: channel, author, text, options
function addMessage(channel, author, text, options = {}) {
  if (!state.messages[channel]) return;

  const messageId = options.id || crypto.randomUUID();
  const existing = state.messages[channel].find(m => m.id === messageId);
  if (existing) return existing;
  const message = {
    id: messageId,
    author: author,
    text: text,
    mentions: options.mentions || parseMentions(text),
    target: options.target || null,
    time: options.time ? new Date(options.time) : new Date(),
    sender: options.sender || null,
    widget: options.widget || null
  };
  state.messages[channel].push(message);

  if (channel === state.currentChannel) {
    renderMessages();
  } else {
    state.unread[channel]++;
  }
  renderBadges();
  return message;
}

// Find a message by id in any channel.
// params: id
function findMessage(id) {
  for (const channel in state.messages) {
    const found = state.messages[channel].find(m => m.id === id);
    if (found) return found;
  }
}


// ---------- CUSTOM WIDGETS ----------
//
// A widget is a message with its own UI.
//
//   type        data it needs                                  needs you?
//   approval    { title, details, action }                     yes
//   plan        { title, steps: ["step", ...] }                yes
//   orchestrate { lead, followers: [...], task }               yes
//   choice      { question, options: ["a", "b", ...] }         yes
//   progress    { label, percent }                             no
//
// Widgets that need you land in #pending. Progress goes to #general
// unless you pass a channel.

// params: author, type, data, channel, id
function addWidget(author, type, data, channel, id) {
  const needsYou = type !== "progress";
  const where = channel || (needsYou ? "pending" : "general");
  return addMessage(where, author, "", { id: id, widget: { type, data, result: null } });
}

// You answer a widget. result looks like:
//   { approved: true | false, steps?: [...], choice?: "..." }
// params: messageId, result
function resolveWidget(messageId, result) {
  const message = findMessage(messageId);
  if (!message) return;
  message.widget.result = result;

  // An approved orchestration sends the lead's order to every follower.
  if (message.widget.type === "orchestrate" && result.approved) {
    const { lead, followers, task } = message.widget.data;
    followers.forEach(f => {
      sendToNetwork({ type: "message", channel: "orchestrate", author: lead, text: task, target: f });
    });
  }

  sendToNetwork({ type: "widget-result", id: messageId, result: result });
  renderMessages();
  renderBadges();
}

// Change a progress widget's bar.
// params: messageId, percent
function updateProgress(messageId, percent, broadcast = true) {
  const message = findMessage(messageId);
  if (!message || !message.widget) return;
  message.widget.data.percent = Math.max(0, Math.min(100, percent));
  renderMessages();
  if (broadcast) sendToNetwork({ type: "progress", id: messageId, percent: message.widget.data.percent });
}

// How many widgets are still waiting on you.
// params: none
function countWaiting() {
  return state.messages.pending.filter(m => m.widget && !m.widget.result).length;
}


// ---------- WIDGET BUILDERS ----------

// The shared frame: status tag, title, body, footer.
// params: message, waitingLabel, title, status
function buildShell(message, waitingLabel, title, status) {
  const result = message.widget.result;
  const tagText = status === "waiting" ? waitingLabel
                : status === "denied"  ? "Denied"
                : result && result.choice ? "Answered"
                : status === "running" ? "In progress"
                : result ? "Approved" : "Done";

  const card = el("div", "widget " + status);
  const head = el("div", "w-head");
  const tone = status === "denied" ? "bad" : status === "done" ? "ok" : "warn live";
  head.appendChild(el("span", "tag " + tone, tagText));
  card.appendChild(head);
  if (title) card.appendChild(el("div", "w-title", title));

  const body = el("div", "w-body");
  const foot = el("div", "w-foot");
  card.appendChild(body);
  return { card, body, foot };
}

// "waiting", "denied" or "done" from the result.
// params: message
function statusOf(message) {
  const result = message.widget.result;
  if (!result) return "waiting";
  return result.approved ? "done" : "denied";
}

// Approve / Deny buttons. getExtra (optional) adds data to the result.
// params: shell, message, approveText, getExtra
function addDecisionButtons(shell, message, approveText, getExtra) {
  const approve = el("button", "btn primary", approveText);
  approve.onclick = () => resolveWidget(message.id, { approved: true, ...(getExtra ? getExtra() : {}) });
  const deny = el("button", "btn danger", "Deny");
  deny.onclick = () => resolveWidget(message.id, { approved: false });
  shell.foot.append(approve, deny);
  shell.card.appendChild(shell.foot);
}

// params: message
function buildApproval(message) {
  const { title, details, action } = message.widget.data;
  const shell = buildShell(message, "Approval required to continue", title, statusOf(message));
  if (details) shell.body.appendChild(el("div", "", details));
  if (action) shell.body.appendChild(el("code", "", action));
  if (!message.widget.result) addDecisionButtons(shell, message, "Approve");
  return shell.card;
}

// params: message
function buildPlan(message) {
  const { title, steps } = message.widget.data;
  const result = message.widget.result;
  const shell = buildShell(message, "Plan needs approval", title, statusOf(message));

  const list = el("ul", "steps");
  const switches = [];   // one checkbox per step, so you can drop steps before approving

  steps.forEach(step => {
    const item = el("li", "step");
    item.appendChild(el("span", "", step));

    if (!result) {
      const label = el("label", "switch");
      const box = el("input");
      box.type = "checkbox";
      box.checked = true;
      box.onchange = () => item.classList.toggle("off", !box.checked);
      label.append(box, el("i"));
      item.appendChild(label);
      switches.push({ step, box });
    } else if (result && result.approved && !result.steps.includes(step)) {
      item.classList.add("off");   // you switched this one off
    }
    list.appendChild(item);
  });
  shell.body.appendChild(list);

  if (!result) {
    addDecisionButtons(shell, message, "Approve plan", () => ({
      steps: switches.filter(s => s.box.checked).map(s => s.step)
    }));
  }
  return shell.card;
}

// params: message
function buildOrchestrate(message) {
  const { lead, followers, task } = message.widget.data;
  const shell = buildShell(message, "Orchestration needs approval", "One leads, the rest follow", statusOf(message));

  const flow = el("div", "flow");
  const leadChip = el("span", "chip lead");
  leadChip.append(makeAvatar(lead), el("span", "", lead));
  flow.append(leadChip, el("span", "arrow", "leads"));

  const group = el("div", "followers");
  followers.forEach(name => {
    const chip = el("span", "chip");
    chip.append(makeAvatar(name), el("span", "", name));
    group.appendChild(chip);
  });
  flow.appendChild(group);

  shell.body.append(flow, el("div", "", task));
  if (!message.widget.result) addDecisionButtons(shell, message, "Approve orchestration");
  return shell.card;
}

// params: message
function buildChoice(message) {
  const { question, options } = message.widget.data;
  const result = message.widget.result;
  const shell = buildShell(message, "Your input needed", question, result ? "done" : "waiting");

  const row = el("div", "choices");
  if (result) {
    row.appendChild(el("span", "chip", result.choice));
  } else {
    options.forEach(option => {
      const button = el("button", "btn", option);
      button.onclick = () => resolveWidget(message.id, { approved: true, choice: option });
      row.appendChild(button);
    });
  }
  shell.body.appendChild(row);
  return shell.card;
}

// params: message
function buildProgress(message) {
  const { label, percent } = message.widget.data;
  const shell = buildShell(message, "", label, percent >= 100 ? "done" : "running");

  const bar = el("div", "bar");
  const fill = el("div", "fill");
  fill.style.width = percent + "%";
  bar.appendChild(fill);
  shell.body.append(el("div", "", percent + "%"), bar);
  return shell.card;
}

// Add a new widget type by writing a builder and listing it here.
const WIDGETS = {
  approval: buildApproval,
  plan: buildPlan,
  orchestrate: buildOrchestrate,
  choice: buildChoice,
  progress: buildProgress
};


// ---------- CHANNELS ----------

// params: channel
function switchChannel(channel) {
  state.currentChannel = channel;
  state.unread[channel] = 0;

  document.body.dataset.channel = channel;   // CSS reads this for the accent color
  nameEl.textContent = channel;
  topicEl.textContent = CHANNELS[channel];

  document.querySelectorAll(".channel").forEach(button => {
    button.classList.toggle("active", button.dataset.channel === channel);
  });

  renderMessages();
  renderBadges();
}


// ---------- AGENTS ----------

// params: name
function addAgent(name) {
  if (state.agents.includes(name)) return;
  state.agents.push(name);
  renderAgents();
}

// params: name
function removeAgent(name) {
  state.agents = state.agents.filter(a => a !== name);
  renderAgents();
}


// ---------- RENDERING ----------

// Same name, same color, every time.
// params: name
function colorFor(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash}, 60%, 70%)`;
}

// params: name
function makeAvatar(name) {
  const avatar = el("div", "avatar", name[0].toUpperCase());
  avatar.style.background = colorFor(name);
  return avatar;
}

// params: date
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// params: none
function renderMessages() {
  messagesEl.innerHTML = "";
  const list = state.messages[state.currentChannel];

  if (list.length === 0) {
    messagesEl.appendChild(el("p", "empty", "Nothing here yet. Messages from agents will show up as they arrive."));
    return;
  }

  let previous = null;
  list.forEach(message => {
    // Same author within 5 minutes, no widgets: stack the messages tightly.
    const grouped = previous && previous.author === message.author
      && !previous.widget && !message.widget
      && message.time - previous.time < 5 * 60 * 1000;
    messagesEl.appendChild(buildMessage(message, grouped));
    previous = message;
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// params: message, grouped
function buildMessage(message, grouped) {
  const row = el("div", "msg");
  if (grouped) row.classList.add("grouped");
  if (state.currentChannel === "orchestrate") row.classList.add("command");
  if (message.mentions.includes("You")) row.classList.add("pinged");

  const body = el("div", "body");

  const meta = el("div", "meta");
  meta.appendChild(el("span", "author", message.author));
  if (message.target) meta.appendChild(el("span", "target", "to " + message.target));
  meta.appendChild(el("span", "time", formatTime(message.time)));
  body.appendChild(meta);

  if (message.widget) {
    body.appendChild(WIDGETS[message.widget.type](message));
  } else {
    body.appendChild(buildText(message.text));
  }

  row.append(makeAvatar(message.author), body);
  return row;
}

// params: none
function renderBadges() {
  document.querySelectorAll(".channel").forEach(button => {
    const channel = button.dataset.channel;
    // pending shows how many still need you; other channels show unread
    const count = channel === "pending" ? countWaiting() : state.unread[channel];
    button.querySelector(".badge").textContent = count > 0 ? count : "";
  });

  const waiting = countWaiting();
  pillEl.hidden = waiting === 0;
  pillEl.textContent = waiting + " waiting on you";
}

// params: none
function renderAgents() {
  agentListEl.innerHTML = "";
  state.agents.forEach(name => {
    const row = el("div", "agent");
    row.append(makeAvatar(name), el("span", "", name));
    agentListEl.appendChild(row);
  });
}


// ---------- MENTIONS (@Agent) ----------
// Agent names must be one word. "@You" pings you.

const mentionMenuEl = document.getElementById("mention-menu");
let mentionMatches = [];   // agent names shown in the menu
let mentionIndex = 0;      // which one is highlighted

// params: text
function parseMentions(text) {
  const names = [...text.matchAll(/@(\w+)/g)].map(match => match[1]);
  return names.filter(name => name === "You" || state.agents.includes(name));
}

// params: text
function buildText(text) {
  const box = el("div", "text");
  text.split(/(@\w+)/g).forEach(part => {
    const name = part.slice(1);
    const isMention = part.startsWith("@") && (name === "You" || state.agents.includes(name));
    box.appendChild(isMention ? el("span", "mention", part) : document.createTextNode(part));
  });
  return box;
}

// params: none
function updateMentionMenu() {
  const match = inputEl.value.match(/@(\w*)$/);   // an @ at the end of what you typed
  if (!match) return hideMentionMenu();

  const query = match[1].toLowerCase();
  mentionMatches = state.agents.filter(name => name.toLowerCase().startsWith(query));
  if (mentionMatches.length === 0) return hideMentionMenu();

  mentionIndex = 0;
  renderMentionMenu();
}

// params: none
function renderMentionMenu() {
  mentionMenuEl.innerHTML = "";
  mentionMatches.forEach((name, i) => {
    const item = el("button", "mention-item" + (i === mentionIndex ? " active" : ""));
    item.type = "button";
    item.append(makeAvatar(name), el("span", "", name));
    item.onmousedown = event => { event.preventDefault(); pickMention(name); };
    mentionMenuEl.appendChild(item);
  });
  mentionMenuEl.hidden = false;
}

// params: none
function hideMentionMenu() {
  mentionMenuEl.hidden = true;
  mentionMatches = [];
}

// params: name
function pickMention(name) {
  inputEl.value = inputEl.value.replace(/@(\w*)$/, "@" + name + " ");
  hideMentionMenu();
  inputEl.focus();
}

inputEl.addEventListener("input", updateMentionMenu);

// Arrow keys move, Enter or Tab picks, Escape closes.
inputEl.addEventListener("keydown", event => {
  if (mentionMenuEl.hidden) return;
  if (event.key === "ArrowDown") mentionIndex = (mentionIndex + 1) % mentionMatches.length;
  else if (event.key === "ArrowUp") mentionIndex = (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
  else if (event.key === "Enter" || event.key === "Tab") pickMention(mentionMatches[mentionIndex]);
  else if (event.key === "Escape") hideMentionMenu();
  else return;
  event.preventDefault();
  if (!mentionMenuEl.hidden) renderMentionMenu();
});


// ---------- YOUR OWN MESSAGES + CLICKS ----------

composerEl.addEventListener("submit", event => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  sendToNetwork({ type: "message", channel: state.currentChannel, author: "You", text: text, mentions: parseMentions(text) });

  inputEl.value = "";
  hideMentionMenu();
});

document.querySelectorAll(".channel").forEach(button => {
  button.addEventListener("click", () => switchChannel(button.dataset.channel));
});

pillEl.addEventListener("click", () => switchChannel("pending"));


// ---------- NETWORK (PeerJS / WebRTC, no Murmur backend) ----------
// The room creator's browser is the room host. PeerJS Cloud only performs
// signaling; chat packets travel directly between connected browsers.

let client = null;
let currentInviteToken = null;

const connectEl = document.getElementById("connect");
const connectMsgEl = document.getElementById("connect-msg");
const roomDotEl = document.getElementById("room-dot");
const roomLabelEl = document.getElementById("room-label");
const roomIdEl = document.getElementById("room-id");
const hostButton = document.getElementById("host-btn");
const joinButton = document.getElementById("join-btn");

function setConnectMessage(text, isError = false) {
  connectMsgEl.textContent = text;
  connectMsgEl.classList.toggle("error", isError);
}

function setRoomStatus(text, isOnline) {
  roomLabelEl.textContent = text;
  roomDotEl.classList.toggle("on", isOnline);
}

function enterRoom(label, roomId) {
  connectEl.hidden = true;
  roomIdEl.textContent = roomId;
  setRoomStatus(label, true);
  renderBadges();
  renderMessages();
}

function ingestServerMessage(raw) {
  if (!raw || !state.messages[raw.channel]) return;
  if (raw.widget) {
    addWidget(raw.author, raw.widget.type, raw.widget.data, raw.channel, raw.id);
    const saved = findMessage(raw.id);
    if (saved) {
      saved.time = new Date(raw.time || Date.now());
      saved.sender = raw.sender || null;
      saved.widget.result = raw.widget.result || null;
    }
    renderMessages();
    return;
  }
  addMessage(raw.channel, raw.author, raw.text || "", {
    id: raw.id,
    time: raw.time,
    target: raw.target,
    mentions: raw.mentions,
    sender: raw.sender
  });
}

function replaceHistory(messages) {
  for (const channel of Object.keys(state.messages)) state.messages[channel] = [];
  for (const channel of Object.keys(state.unread)) state.unread[channel] = 0;
  for (const message of messages || []) ingestServerMessage(message);
  renderMessages();
  renderBadges();
}

function handleRoomEvent(event) {
  if (!event || typeof event.type !== "string") return;

  if (event.type === "welcome") {
    state.agents = (event.members || [])
      .filter(member => member.name !== "You")
      .map(member => member.name);
    renderAgents();
    return;
  }

  if (event.type === "message.created" || event.type === "widget.created") {
    ingestServerMessage(event.message);
    return;
  }

  if (event.type === "widget.resolved") {
    const message = findMessage(event.id);
    if (message && message.widget) {
      message.widget.result = event.result;
      renderMessages();
      renderBadges();
    }
    return;
  }

  if (event.type === "progress.updated") {
    updateProgress(event.id, event.percent, false);
    return;
  }

  if (event.type === "member.joined") {
    if (event.member?.name && event.member.name !== "You") addAgent(event.member.name);
    return;
  }

  if (event.type === "member.left") {
    if (event.member?.name && event.member.name !== "You") removeAgent(event.member.name);
    return;
  }

  if (event.type === "members.updated" || event.type === "presence.changed") {
    state.agents = (event.members || [])
      .filter(member => member.name !== "You")
      .map(member => member.name);
    renderAgents();
    return;
  }

  if (event.type === "room.closed") {
    setRoomStatus("Room host closed the room", false);
    return;
  }

  if (event.type === "error") {
    const message = event.error || "A room error occurred.";
    if (connectEl.hidden) setRoomStatus(message, false);
    else setConnectMessage(message, true);
  }
}

function bindClient(nextClient) {
  client = nextClient;
  client.on("event", handleRoomEvent);
  client.on("disconnected", detail => {
    setRoomStatus(detail?.reason || "Disconnected", false);
  });
  client.on("peerError", error => {
    const message = error?.type === "network" || error?.type === "socket-error"
      ? "PeerJS signaling is unavailable. Check your connection and try again."
      : (error?.message || error?.type || "Peer connection error.");
    if (connectEl.hidden) setRoomStatus(message, false);
    else setConnectMessage(message, true);
  });
  client.on("serverError", event => setRoomStatus(event.error || "Connection error", false));
}

async function connectToRoom(roomId, token, name = "You", kind = "human") {
  setConnectMessage("Connecting to room…");
  setRoomStatus("Connecting…", false);
  hostButton.disabled = true;
  joinButton.disabled = true;

  try {
    client?.close();
    const nextClient = createMurmurClient();
    bindClient(nextClient);
    await nextClient.connect({ room: roomId, token, name, kind });
    const history = await nextClient.getHistory({ limit: 300 });
    replaceHistory(history.messages || []);
    const roster = await nextClient.getMembers();
    state.agents = (roster.members || [])
      .filter(member => member.name !== "You")
      .map(member => member.name);
    renderAgents();

    sessionStorage.setItem("murmur.room", roomId);
    sessionStorage.setItem("murmur.inviteToken", token);
    sessionStorage.setItem("murmur.name", name);
    sessionStorage.setItem("murmur.kind", kind);
    if (nextClient.accessToken) sessionStorage.setItem("murmur.apiAccessToken", nextClient.accessToken);
    currentInviteToken = token;
    enterRoom(window.MURMUR_CONFIG?.apiBase ? "Connected · shared API" : "Connected · peer-to-peer", roomId);
    setConnectMessage("");
  } catch (error) {
    setRoomStatus("Not connected", false);
    setConnectMessage(error.message || "Couldn't connect to that room.", true);
    throw error;
  } finally {
    hostButton.disabled = false;
    joinButton.disabled = false;
  }
}

async function createRoom() {
  setConnectMessage(window.MURMUR_CONFIG?.apiBase ? "Creating a shared room…" : "Opening a peer-to-peer room…");
  hostButton.disabled = true;
  joinButton.disabled = true;

  const savedRoom = localStorage.getItem("murmur.hostRoom");
  const savedToken = localStorage.getItem("murmur.hostToken");
  try {
    client?.close();
    let nextClient = createMurmurClient();
    bindClient(nextClient);
    let created;
    try {
      created = await nextClient.createRoom({ roomId: savedRoom || undefined, token: savedToken || undefined });
    } catch (error) {
      // The saved peer ID may still be registered in another open tab.
      if (!savedRoom || error?.type !== "unavailable-id") throw error;
      nextClient.close();
      nextClient = createMurmurClient();
      bindClient(nextClient);
      created = await nextClient.createRoom();
    }

    currentInviteToken = created.inviteToken;
    localStorage.setItem("murmur.hostRoom", created.roomId);
    localStorage.setItem("murmur.hostToken", created.inviteToken);
    sessionStorage.setItem("murmur.room", created.roomId);
    sessionStorage.setItem("murmur.inviteToken", created.inviteToken);
    sessionStorage.setItem("murmur.name", "You");
    sessionStorage.setItem("murmur.kind", "human");
    if (nextClient.accessToken) sessionStorage.setItem("murmur.apiAccessToken", nextClient.accessToken);

    const history = await nextClient.getHistory({ limit: 300 });
    replaceHistory(history.messages || []);
    const roster = await nextClient.getMembers();
    state.agents = (roster.members || []).filter(member => member.name !== "You").map(member => member.name);
    renderAgents();
    enterRoom(window.MURMUR_CONFIG?.apiBase ? "Room online · shared API" : "Room host online · peer-to-peer", created.roomId);
    setConnectMessage("");
  } catch (error) {
    setConnectMessage(error.message || "Couldn't create a room.", true);
    setRoomStatus("Not connected", false);
  } finally {
    hostButton.disabled = false;
    joinButton.disabled = false;
  }
}

async function joinRoom() {
  const roomId = document.getElementById("join-room").value.trim();
  const token = document.getElementById("join-token").value.trim();
  const name = document.getElementById("join-name").value.trim();
  if (!roomId || !token || !name) {
    setConnectMessage("Enter the room ID, invite key and your name.", true);
    return;
  }
  try {
    await connectToRoom(roomId, token, name, "human");
  } catch {
    // connectToRoom already displays the useful error.
  }
}

function sendToNetwork(data) {
  if (!client?.connected) {
    setRoomStatus("Disconnected", false);
    return;
  }
  try {
    if (data.type === "message") {
      client.sendMessage(data.text, { channel: data.channel, target: data.target });
    } else if (data.type === "widget-result") {
      client.respondToWidget(data.id, data.result);
    } else if (data.type === "widget") {
      client.createWidget(data.widgetType, data.data, { channel: data.channel });
    } else if (data.type === "progress") {
      client.updateProgress(data.id, data.percent);
    }
  } catch (error) {
    setRoomStatus(error.message || "Send failed", false);
  }
}

hostButton.addEventListener("click", createRoom);
joinButton.addEventListener("click", joinRoom);

document.getElementById("copy-btn").addEventListener("click", async () => {
  if (!roomIdEl.textContent || !currentInviteToken) return;
  try {
    const link = new URL("index.html", location.href);
    link.hash = new URLSearchParams({ room: roomIdEl.textContent, key: currentInviteToken }).toString();
    await navigator.clipboard.writeText(link.toString());
    const button = document.getElementById("copy-btn");
    const oldText = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = oldText; }, 1200);
  } catch (error) {
    setRoomStatus(error.message || "Couldn't copy invite", false);
  }
});

window.addEventListener("beforeunload", () => {
  if (client) client.close();
});

switchChannel("general");

// Invite links pre-fill the join form. A visitor still chooses their own name.
const query = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.slice(1));
const invitedRoom = fragment.get("room") || query.get("room");
const invitedKey = fragment.get("key") || query.get("key");
if (invitedRoom) document.getElementById("join-room").value = invitedRoom;
if (invitedKey) document.getElementById("join-token").value = invitedKey;
if (invitedRoom && invitedKey) document.getElementById("join-name").focus();

// Resume this browser's last room as a host or participant when the tab reloads.
const savedRoom = sessionStorage.getItem("murmur.room");
const savedToken = sessionStorage.getItem("murmur.inviteToken");
const savedName = sessionStorage.getItem("murmur.name");
const savedKind = sessionStorage.getItem("murmur.kind");
async function resumeSavedRoom(roomId, inviteCode, name, kind, accessToken) {
  try {
    client?.close();
    const nextClient = createMurmurClient();
    if (typeof nextClient.resume !== "function") throw new Error("This transport cannot resume sessions.");
    bindClient(nextClient);
    await nextClient.resume({ room: roomId, inviteCode, accessToken });
    const history = await nextClient.getHistory({ limit: 300 });
    replaceHistory(history.messages || []);
    const roster = await nextClient.getMembers();
    state.agents = (roster.members || []).filter(member => member.name !== "You").map(member => member.name);
    renderAgents();
    currentInviteToken = inviteCode;
    enterRoom(window.MURMUR_CONFIG?.apiBase ? "Reconnected · shared API" : "Reconnected", roomId);
    setConnectMessage("");
  } catch (error) {
    sessionStorage.removeItem("murmur.apiAccessToken");
    setConnectMessage("Couldn't resume the saved room: " + (error.message || "session expired"), true);
  }
}

if (savedRoom && savedToken && savedName && window.MURMUR_CONFIG?.apiBase) {
  const apiAccessToken = sessionStorage.getItem("murmur.apiAccessToken");
  if (apiAccessToken) {
    resumeSavedRoom(savedRoom, savedToken, savedName, savedKind || "human", apiAccessToken);
  } else if (savedName === "You" && savedRoom === localStorage.getItem("murmur.hostRoom")) {
    createRoom();
  } else {
    connectToRoom(savedRoom, savedToken, savedName, savedKind || "human").catch(() => {});
  }
} else if (savedRoom && savedToken && savedName === "You" && savedRoom === localStorage.getItem("murmur.hostRoom")) {
  createRoom();
} else if (savedRoom && savedToken && savedName) {
  connectToRoom(savedRoom, savedToken, savedName, savedKind || "human").catch(() => {});
}
