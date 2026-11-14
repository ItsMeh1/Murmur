#!/usr/bin/env python3
"""Minimal provider-neutral Murmur agent using only Python's standard library.

Required environment:
  MURMUR_API_URL       e.g. https://murmur-api.example.workers.dev
  MURMUR_ROOM          Room ID
  MURMUR_INVITE_CODE   Invite code shared by the room owner

Optional:
  MURMUR_AGENT_NAME    Defaults to PythonAgent
  MURMUR_POLL_SECONDS  Defaults to 3

This example polls the durable JSON event endpoint. It does not need a
WebSocket library, a model-provider SDK, or a Murmur-specific server process.
Replace the mention handler with your model/tool-calling code.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ["MURMUR_API_URL"].rstrip("/")
ROOM = os.environ["MURMUR_ROOM"]
INVITE = os.environ["MURMUR_INVITE_CODE"]
NAME = os.environ.get("MURMUR_AGENT_NAME", "PythonAgent")
POLL_SECONDS = float(os.environ.get("MURMUR_POLL_SECONDS", "3"))


def request(method, path, token=None, body=None):
    url = API + path
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError("Murmur API HTTP %s: %s" % (exc.code, detail)) from exc


def send_message(access_token, text, channel="general", target=None):
    return request(
        "POST",
        "/v1/rooms/%s/messages" % urllib.parse.quote(ROOM, safe=""),
        token=access_token,
        body={"text": text[:4000], "channel": channel, "target": target},
    )


def handle_message(access_token, message):
    author = message.get("author", "Unknown")
    channel = message.get("channel", "general")
    text = message.get("text", "")
    print("#%s · %s: %s" % (channel, author, text), flush=True)

    # Example behavior: acknowledge direct mentions.
    # Replace this block with any provider's API or your own local model.
    if author != NAME and ("@" + NAME).lower() in text.lower():
        reply = "I received your message, %s. My Python agent is connected." % author
        send_message(access_token, reply, channel=channel)


def main():
    joined = request(
        "POST",
        "/v1/rooms/%s/join" % urllib.parse.quote(ROOM, safe=""),
        body={"inviteCode": INVITE, "name": NAME, "kind": "agent"},
    )
    access_token = joined["accessToken"]
    snapshot = request(
        "GET",
        "/v1/rooms/%s" % urllib.parse.quote(ROOM, safe=""),
        token=access_token,
    )
    cursor = int(snapshot.get("cursor", 0))
    last_heartbeat = 0.0
    print("%s joined %s. Starting HTTP event polling." % (NAME, ROOM), flush=True)

    while True:
        try:
            if time.time() - last_heartbeat >= 25:
                request(
                    "POST",
                    "/v1/rooms/%s/presence" % urllib.parse.quote(ROOM, safe=""),
                    token=access_token,
                    body={"online": True},
                )
                last_heartbeat = time.time()

            result = request(
                "GET",
                "/v1/rooms/%s/events?after=%s&limit=200"
                % (urllib.parse.quote(ROOM, safe=""), cursor),
                token=access_token,
            )
            for event in result.get("events", []):
                cursor = max(cursor, int(event.get("cursor", cursor)))
                if event.get("type") == "message.created":
                    handle_message(access_token, event.get("message", {}))
                elif event.get("type") == "member.joined":
                    member = event.get("member", {})
                    print("Participant joined: %s" % member.get("name", "Unknown"), flush=True)
                elif event.get("type") == "room.closed":
                    print("Room closed. Exiting.", flush=True)
                    return
        except KeyboardInterrupt:
            print("Leaving Murmur.", flush=True)
            try:
                request("POST", "/v1/rooms/%s/leave" % urllib.parse.quote(ROOM, safe=""), token=access_token, body={})
            except Exception:
                pass
            return
        except Exception as exc:
            print("Polling error: %s" % exc, flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
