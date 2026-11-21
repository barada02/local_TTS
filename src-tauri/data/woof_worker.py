"""Worker process for tts-bench: runs Underdog Woof and streams audio back.

Started by the app as: python woof_worker.py <folder holding woof_int8.npz and underdog_woof/>

Protocol (binary on stdout, JSON lines on stdin):
  stdin   {"cmd": "prepare", "voice": "juno"}            load a voice
          {"cmd": "speak", "text": "...", "voice": "juno", "seed": 0}
          {"cmd": "cancel"}                              stop the current speak
          {"cmd": "quit"}
  stdout  frames of  [type: u8][length: u32 little-endian][payload]
          0 READY     json {"sr": 24000, "voices": [...]}
          1 PREPARED  json {"ms": load time}
          2 AUDIO     float32 little-endian mono samples (one piece of the text)
          3 DONE      empty
          4 ERROR     utf-8 message
"""
import json
import os
import queue
import struct
import sys
import threading
import time

import numpy as np

here = sys.argv[1]
sys.path.insert(0, here)

# Keep stray prints off the binary channel.
out = sys.stdout.buffer
sys.stdout = sys.stderr

READY, PREPARED, AUDIO, DONE, ERROR = range(5)


def send(kind, payload=b""):
    out.write(struct.pack("<BI", kind, len(payload)) + payload)
    out.flush()


from underdog_woof import SR, VOICES, Woof  # noqa: E402
from underdog_woof.runtime import RNG  # noqa: E402
from underdog_woof.textsplit import split_text  # noqa: E402

cancel = threading.Event()
inbox = queue.Queue()


def read_stdin():
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("cmd") == "cancel":
            cancel.set()
        else:
            inbox.put(msg)
    inbox.put({"cmd": "quit"})


threading.Thread(target=read_stdin, daemon=True).start()

tts = None
current = None


def voice_model(voice):
    """The Woof model for `voice`; only one is kept in memory at a time."""
    global tts, current
    if voice not in VOICES:
        raise ValueError(f"Unknown voice: {voice}")
    if current != voice:
        tts = None  # free the old one first
        tts = Woof(weights=os.path.join(here, "woof_int8.npz"), voice=voice)
        current = voice
    return tts


send(READY, json.dumps({"sr": SR, "voices": list(VOICES)}).encode())

while True:
    msg = inbox.get()
    cmd = msg.get("cmd")
    if cmd == "quit":
        break
    try:
        if cmd == "prepare":
            started = time.perf_counter()
            voice_model(msg["voice"])
            send(PREPARED, json.dumps({"ms": (time.perf_counter() - started) * 1000}).encode())
        elif cmd == "speak":
            cancel.clear()  # drops a stale cancel from an earlier run
            woof = voice_model(msg["voice"])
            seed = msg.get("seed")
            if seed is not None:
                RNG.seed(seed)
            text = msg["text"]
            if woof.norm is not None:
                text = woof.norm(text)
            # Same steps as Woof.__call__, but each piece is sent as soon as it
            # is made, so playback can start before the whole text is done.
            for piece in split_text(text) or [text]:
                if cancel.is_set():
                    break
                wav = woof._piece(piece).astype(np.float32)
                send(AUDIO, wav.tobytes())
            send(DONE)
    except Exception as exc:  # noqa: BLE001
        send(ERROR, f"{type(exc).__name__}: {exc}".encode())
