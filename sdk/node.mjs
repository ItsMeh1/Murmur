// Node.js adapter for the same browser SDK. PeerJS 1.5.5 includes Node support.
import { Peer } from "peerjs";

globalThis.Peer = Peer;
await import("../murmur-sdk.js");

export const MurmurClient = globalThis.MurmurClient;
export default MurmurClient;
