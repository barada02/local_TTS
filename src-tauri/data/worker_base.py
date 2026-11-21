"""Shared protocol for tts-bench worker processes (Python side).

A worker script loads its model, then calls `serve(...)`. The app (see
src/engines/pyworker.rs) talks to it over stdin/stdout:

  stdin   one JSON object per line
          {"cmd": "prepare", "voice": "..."}     load a voice (may be a no-op)
          {"cmd": "speak", "text": "...", "voice": "...", ...}
          {"cmd": "cancel"}                      stop the current speak
          {"cmd": "quit"}
  stdout  binary frames  [type: u8][length: u32 little-endian][payload]
          0 READY     json (sent once the model is loaded)
          1 PREPARED  json {"ms": time it took}
          2 AUDIO     float32 little-endian mono samples (one piece of the text)
          3 DONE      empty
          4 ERROR     utf-8 message
"""
import json
import queue
import struct
import sys
import threading
import time

import numpy as np

READY, PREPARED, AUDIO, DONE, ERROR = range(5)

# The binary channel is the real stdout; stray prints go to stderr (the log).
_out = sys.stdout.buffer
sys.stdout = sys.stderr


def _send(kind, payload=b""):
    _out.write(struct.pack("<BI", kind, len(payload)) + payload)
    _out.flush()


def serve(info, prepare, speak):
    """Runs the request loop.

    info      dict sent with READY (for example {"sr": 24000})
    prepare   prepare(voice): load a voice
    speak     speak(msg, emit, cancelled): generate speech for msg["text"] in
              msg["voice"]; call emit(array) with each piece of audio and stop
              when cancelled() is true
    """
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

    def emit(audio):
        _send(AUDIO, np.ascontiguousarray(audio, dtype="<f4").reshape(-1).tobytes())

    _send(READY, json.dumps(info).encode())
    while True:
        msg = inbox.get()
        cmd = msg.get("cmd")
        if cmd == "quit":
            break
        try:
            if cmd == "prepare":
                started = time.perf_counter()
                prepare(msg["voice"])
                _send(PREPARED, json.dumps({"ms": (time.perf_counter() - started) * 1000}).encode())
            elif cmd == "speak":
                cancel.clear()  # drops a stale cancel from an earlier run
                speak(msg, emit, cancel.is_set)
                _send(DONE)
        except Exception as exc:  # noqa: BLE001
            _send(ERROR, f"{type(exc).__name__}: {exc}".encode())
