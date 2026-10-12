"""Run the stock edge-tts CLI, trying the new Edge TTS host before the legacy one.

Since 2026-10-12 the legacy speech.platform.bing.com WebSocket answers 403 for synthesis
(rany2/edge-tts#490). api.msedgeservices.com accepts the same request and returns the same
mp3 format. Same arguments as `edge-tts`.
"""
import sys

from aiohttp import WSServerHandshakeError
import edge_tts.communicate as communicate
from edge_tts.constants import TRUSTED_CLIENT_TOKEN, WSS_URL as LEGACY
from edge_tts.util import main

HOSTS = [f"wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}", LEGACY]

for i, url in enumerate(HOSTS):
    communicate.WSS_URL = url
    try:
        main()
        break
    except WSServerHandshakeError as e:
        if e.status != 403 or i == len(HOSTS) - 1:
            raise
        print(f"{url.split('?')[0]}: 403, trying the next host", file=sys.stderr)
