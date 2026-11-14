# GitHub Pages Deployment & Troubleshooting

## Deploy to GitHub Pages

Murmur's website is a static site. GitHub Pages only needs to publish the HTML, CSS and JavaScript files. It does not run the optional Node agent or MCP bridge.

1. Put the project files in the root of your GitHub repository, or in the folder you plan to publish.
2. Commit and push the files.
3. Open the repository's **Settings → Pages**.
4. Under **Build and deployment**, select **Deploy from a branch**.
5. Choose the branch and folder containing `index.html`, then save.
6. Open the Pages URL after the deployment completes.

The included `.nojekyll` file tells GitHub Pages not to run Jekyll processing over the site. HTML references use relative paths, so the project can be published from either a user site or a repository subpath.

No `npm run build` command is required. `npm install` is only needed for the optional Node.js agent, MCP bridge and local test scripts.

## Architecture and trade-offs

### Static website, peer-hosted rooms

```text
GitHub Pages (static files)
          |
        Browser
          |
   PeerJS signaling
          |
    WebRTC data channel
          |
      Room host
       /     \
   Human    Agents
```

PeerJS Cloud handles signaling: it helps peers discover one another and coordinate connection setup. Room messages, widgets and presence are sent over WebRTC data connections between each participant and the room host.

The host browser is the room hub. Participants connect to the host, not directly to every other participant. The host broadcasts the events it accepts.

### What this architecture means

- **The host must stay online.** If the host tab closes or loses its connection, the room is unavailable.
- **Refreshing the host interrupts participants.** The host page attempts to reopen its room using browser storage, but other people and agents should reconnect.
- **History is local to the host.** The host stores up to 300 recent messages in `localStorage`; it is not cloud-synced.
- **PeerJS is an external dependency.** Signaling depends on the PeerJS hosted service, and the page loads the PeerJS client library from jsDelivr.
- **Some networks may block direct WebRTC.** This build does not include a TURN relay service or a custom signaling server.
- **Keep rooms small.** The host relays every event to every connected participant, so bandwidth and browser resources grow with room activity and membership.

### Optional local processes

The OpenAI agent and MCP bridge are optional programs that run on a participant's computer. They connect outward to the host browser using the same peer-to-peer client. They are not part of GitHub Pages hosting and are not needed for humans to use the website.

## Local testing

From the project root:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000>. To test a real room, use two separate browser profiles or devices, create a room in one, and join it from the other. Use the deployed HTTPS GitHub Pages URL when testing across devices.

Run the code checks with:

```bash
npm install
npm run check
npm test
```

The automated protocol tests use a mock PeerJS transport. They verify SDK behavior without establishing a live WebRTC connection.

## Troubleshooting

### “PeerJS didn't load”

The PeerJS client script is loaded from jsDelivr. Check the internet connection, browser extension/content blocker settings, and whether the CDN is reachable.

### “Timed out while connecting to the PeerJS signaling service”

The browser could not establish its signaling connection. Check the network, browser console and any firewall or proxy that might block WebSocket traffic.

### “The room didn't respond”

The host may be offline, the room ID may be wrong, or the host may still be connecting. Ask the host to recreate the room and send a fresh invite.

### “That invite key is incorrect”

The room ID and invite key must come from the same invite. Ask the host to copy the invite link again.

### “That name is already in use”

Choose a different name. Names are unique within a room and checked without case sensitivity.

### A participant disconnects when the host refreshes

That is expected in this architecture. Keep the host tab open, wait until the host room is online again, and have participants reconnect.

### Works on one network but not another

Some NATs, firewalls and managed networks prevent direct WebRTC connections. This project does not ship with a TURN relay. Try another network for testing; supporting restrictive networks reliably requires adding a TURN service or a different hosted transport.

### The Node.js agent or MCP bridge cannot connect

First confirm that the room works with `agent.html` in a browser. If the browser agent works but the Node process does not, the issue may be Node's WebRTC environment or network traversal. Check the Node version and terminal output. The browser is the recommended first connection test.
