import { z } from "zod";
import { MurmurClient } from "../sdk/api.mjs";

function result(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: value && typeof value === "object" ? value : { result: value },
  };
}

/** Register Murmur tools on the local stdio MCP server. */
export function registerMurmurTools(server, context = {}) {
  const getClient = context.getClient || (() => context.client || null);
  const setClient = context.setClient || (() => {});

  function requireClient() {
    const client = getClient();
    if (!client?.connected) throw new Error("Join a Murmur room first using the join_room tool.");
    return client;
  }

  server.registerTool(
    "join_room",
    {
      title: "Join a Murmur room",
      description: "Connect this assistant to a Murmur room using a room ID and invite token. The connection stays open while this MCP session runs.",
      inputSchema: {
        room: z.string().min(1),
        inviteKey: z.string().min(1),
        name: z.string().regex(/^[A-Za-z0-9_]{1,24}$/).default("Assistant"),
      },
    },
    async ({ room, inviteKey, name }) => {
      getClient()?.close();
      const client = new MurmurClient();
      setClient(client);
      await client.connect({ room, name, token: inviteKey, kind: "agent" });
      return result({ connected: true, room, participant: client.participant });
    },
  );

  server.registerTool(
    "get_messages",
    {
      title: "Read Murmur messages",
      description: "Retrieve recent messages from the connected Murmur room.",
      inputSchema: {
        channel: z.enum(["general", "ideas", "pending", "orchestrate"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ channel, limit }) => result(await requireClient().getHistory({ channel, limit })),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a Murmur message",
      description: "Post a message as this assistant in a Murmur channel.",
      inputSchema: {
        text: z.string().min(1).max(4000),
        channel: z.enum(["general", "ideas", "pending", "orchestrate"]).default("general"),
        target: z.string().max(24).optional(),
      },
    },
    async ({ text, channel, target }) => {
      await requireClient().sendMessage(text, { channel, target });
      return result({ sent: true, channel, target: target || null });
    },
  );

  server.registerTool(
    "wait_for_messages",
    {
      title: "Wait for a Murmur message",
      description: "Wait for the next message in the room. Returns when a message arrives or the timeout expires; call it again to continue listening.",
      inputSchema: {
        timeoutMs: z.number().int().min(1000).max(30000).default(20000),
        channel: z.enum(["general", "ideas", "pending", "orchestrate"]).optional(),
        from: z.string().optional(),
      },
    },
    async ({ timeoutMs, channel, from }) => {
      const message = await requireClient().waitForMessage({
        timeout: timeoutMs,
        predicate: (item) => (!channel || item.channel === channel) && (!from || item.author === from),
      });
      return result(message ? { timedOut: false, message } : { timedOut: true });
    },
  );

  server.registerTool(
    "get_members",
    {
      title: "List Murmur participants",
      description: "See which humans and agents are currently connected to the room.",
      inputSchema: {},
    },
    async () => result(await requireClient().getMembers()),
  );

  server.registerTool(
    "create_widget",
    {
      title: "Create a Murmur widget",
      description: "Post an approval, plan, orchestration, choice, or progress widget in the room.",
      inputSchema: {
        widgetType: z.enum(["approval", "plan", "orchestrate", "choice", "progress"]),
        data: z.record(z.string(), z.unknown()),
        channel: z.enum(["general", "ideas", "pending", "orchestrate"]).optional(),
      },
    },
    async ({ widgetType, data, channel }) => {
      const id = await requireClient().createWidget(widgetType, data, { channel });
      return result({ created: true, id, widgetType });
    },
  );

  server.registerTool(
    "respond_to_widget",
    {
      title: "Resolve a Murmur widget",
      description: "Answer a choice widget, or request that the room owner resolve an approval, plan, or orchestration widget. The host only accepts approvals from its owner.",
      inputSchema: {
        id: z.string().min(1),
        approved: z.boolean(),
        choice: z.string().optional(),
        steps: z.array(z.string()).max(20).optional(),
      },
    },
    async ({ id, approved, choice, steps }) => {
      await requireClient().respondToWidget(id, { approved, ...(choice ? { choice } : {}), ...(steps ? { steps } : {}) });
      return result({ submitted: true, id });
    },
  );

  server.registerTool(
    "update_progress",
    {
      title: "Update Murmur progress",
      description: "Update a progress widget that this agent created.",
      inputSchema: {
        id: z.string().min(1),
        percent: z.number().min(0).max(100),
      },
    },
    async ({ id, percent }) => {
      await requireClient().updateProgress(id, percent);
      return result({ updated: true, id, percent });
    },
  );
}
