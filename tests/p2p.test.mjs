import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const peers = new Map();
let sequence = 0;

class MockConnection extends EventEmitter {
  constructor(localPeer, remotePeer) {
    super();
    this.localPeer = localPeer;
    this.remotePeer = remotePeer;
    this.peer = remotePeer.id;
    this.open = false;
    this.remote = null;
  }
  send(data) {
    if (!this.open || !this.remote?.open) throw new Error("Connection is closed.");
    const copy = structuredClone(data);
    queueMicrotask(() => this.remote.emit("data", copy));
  }
  close() {
    if (!this.open) return;
    this.open = false;
    const other = this.remote;
    if (other?.open) {
      other.open = false;
      queueMicrotask(() => other.emit("close"));
    }
    queueMicrotask(() => this.emit("close"));
  }
}

class MockPeer extends EventEmitter {
  constructor(id) {
    super();
    this.id = id || `mock-peer-${++sequence}`;
    this.connections = [];
    setTimeout(() => {
      if (id && peers.has(id)) {
        this.emit("error", Object.assign(new Error("ID unavailable"), { type: "unavailable-id" }));
        return;
      }
      peers.set(this.id, this);
      this.emit("open", this.id);
    }, 0);
  }
  connect(remoteId) {
    const remotePeer = peers.get(remoteId);
    const localConnection = new MockConnection(this, remotePeer || { id: remoteId });
    this.connections.push(localConnection);
    if (!remotePeer) {
      setTimeout(() => localConnection.emit("error", new Error("Peer not found")), 0);
      return localConnection;
    }
    const remoteConnection = new MockConnection(remotePeer, this);
    localConnection.remote = remoteConnection;
    remoteConnection.remote = localConnection;
    remotePeer.emit("connection", remoteConnection);
    setTimeout(() => {
      localConnection.open = true;
      remoteConnection.open = true;
      localConnection.emit("open");
      remoteConnection.emit("open");
    }, 0);
    return localConnection;
  }
  destroy() {
    peers.delete(this.id);
    for (const connection of this.connections) connection.close();
    this.emit("close");
  }
}

globalThis.Peer = MockPeer;
await import("../murmur-sdk.js");
const { MurmurClient } = globalThis;

const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test("host and agent exchange messages, widgets, progress and roster events", async () => {
  const host = new MurmurClient();
  const created = await host.createRoom({ roomId: "murmur-test-room", token: "test-room-key" });
  assert.equal(created.roomId, "murmur-test-room");

  const agent = new MurmurClient();
  const received = [];
  const agentErrors = [];
  agent.on("message", message => received.push(message));
  agent.on("widgetResolved", event => received.push({ resolved: event.id, result: event.result }));
  agent.on("serverError", event => agentErrors.push(event.error));
  await agent.connect({ room: created.roomId, token: created.inviteToken, name: "Scout", kind: "agent" });
  await tick();

  agent.sendMessage("Hello from Scout", { channel: "general" });
  await tick();
  assert.ok(host.history.some(message => message.text === "Hello from Scout" && message.author === "Scout"));
  assert.ok(received.some(item => item.text === "Hello from Scout"));

  const progressId = agent.createWidget("progress", { label: "Indexing", percent: 10 });
  await tick();
  const progress = host.history.find(message => message.id === progressId);
  assert.equal(progress.widget.type, "progress");
  agent.updateProgress(progressId, 75);
  await tick();
  assert.equal(progress.widget.data.percent, 75);

  const approvalId = agent.createWidget("approval", { title: "Install dependency", action: "npm install example" });
  await tick();
  agent.respondToWidget(approvalId, { approved: true });
  await tick();
  assert.equal(host.history.find(message => message.id === approvalId).widget.result, null);
  assert.ok(agentErrors.some(message => /room host/i.test(message)));
  host.respondToWidget(approvalId, { approved: true });
  await tick();
  assert.ok(received.some(item => item.resolved === approvalId));

  const orchestrationId = agent.createWidget("orchestrate", {
    task: "Review the documentation",
    followers: ["Builder", "Archivist"]
  });
  await tick();
  const orchestration = host.history.find(message => message.id === orchestrationId);
  assert.equal(orchestration.widget.data.lead, "Scout");
  assert.deepEqual(orchestration.widget.data.followers, ["Builder", "Archivist"]);

  const choiceId = agent.createWidget("choice", { question: "Which format?", options: ["JSON", "Markdown"] });
  await tick();
  agent.respondToWidget(choiceId, { approved: true, choice: "JSON" });
  await tick();
  assert.equal(host.history.find(message => message.id === choiceId).widget.result.choice, "JSON");
  assert.ok((await host.getMembers()).members.some(member => member.name === "Scout"));

  agent.close();
  host.close();
});

test("an incorrect invite key is rejected", async () => {
  const host = new MurmurClient();
  const room = await host.createRoom({ roomId: "murmur-private-room", token: "correct-key" });
  const intruder = new MurmurClient();
  await assert.rejects(
    intruder.connect({ room: room.roomId, token: "wrong-key", name: "Intruder" }),
    /invite key is incorrect/i
  );
  intruder.close();
  host.close();
});

test("duplicate participant names are rejected", async () => {
  const host = new MurmurClient();
  const room = await host.createRoom({ roomId: "murmur-name-room", token: "name-key" });
  const first = new MurmurClient();
  await first.connect({ room: room.roomId, token: room.inviteToken, name: "Scout" });
  const second = new MurmurClient();
  await assert.rejects(
    second.connect({ room: room.roomId, token: room.inviteToken, name: "Scout" }),
    /already in use/i
  );
  second.close();
  first.close();
  host.close();
});
