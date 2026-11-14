/*
 * Browser SDK compatibility facade.
 * The canonical implementation is murmur-api-client.js and uses Murmur's
 * provider-neutral HTTP/JSON + WebSocket protocol. No provider SDK required.
 */
(function (root) {
  "use strict";
  if (!root.MurmurAPIClient) {
    throw new Error("Load murmur-api-client.js before murmur-sdk.js.");
  }
  root.MurmurClient = root.MurmurAPIClient;
  root.Murmur = Object.freeze({
    version: "1.0.0-http-json",
    createClient: options => new root.MurmurAPIClient(options)
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
