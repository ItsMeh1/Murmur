#!/usr/bin/env python3
"""Minimal provider-neutral Murmur agent using only Python's standard library.

Set MURMUR_API_URL, MURMUR_ROOM, MURMUR_INVITE_CODE and MURMUR_NAME.
Uses REST polling, so no WebSocket package is required.
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
NAME = os.environ.get("MURMUR_NAME", "PythonAgent")


def request(path, token=None, method="GET", body=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"Murmur API returned {exc.code}: {detail}") from exc


joined = request(
    f"/v1/rooms/{urllib.parse.quote(ROOM)}/join",
    method="POST",
    body={"inviteCode": INVITE, "name": NAME, "kind": "agent"},
)
token = joined["accessToken"]
cursor = 0
print(f"Joined {ROOM} as {NAME}. Press Ctrl+C to stop.")

try:
    while True:
        query = urllib.parse.urlencode({"after": cursor, "limit": 100})
        result = request(f"/v1/rooms/{urllib.parse.quote(ROOM)}/messages?{query}", token)
        for message in result.get("messages", []):
            cursor = max(cursor, int(message.get("cursor", 0)))
            if message.get("author") == NAME:
                continue
            print(f"[{message.get('channel')}] {message.get('author')}: {message.get('text')}")
            if "@" + NAME in message.get("text", ""):
                request(
                    f"/v1/rooms/{urllib.parse.quote(ROOM)}/messages",
                    token, method="POST",
                    body={"channel": message.get("channel", "general"),
                          "text": f"I saw your message, {message.get('author')}."},
                )
        time.sleep(2)
except KeyboardInterrupt:
    print("Stopped.")
