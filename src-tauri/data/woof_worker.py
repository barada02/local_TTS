"""Worker process for tts-bench: runs Underdog Woof (numpy only).

Started by the app as: python woof_worker.py <folder holding woof_int8.npz and underdog_woof/>
Protocol: see worker_base.py.
"""
import os
import sys

here = sys.argv[1]
sys.path.insert(0, here)

import worker_base  # noqa: E402  (sits next to this script)
from underdog_woof import SR, VOICES, Woof  # noqa: E402
from underdog_woof.runtime import RNG  # noqa: E402
from underdog_woof.textsplit import split_text  # noqa: E402

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


def speak(msg, emit, cancelled):
    woof = voice_model(msg["voice"])
    seed = msg.get("seed")
    if seed is not None:
        RNG.seed(seed)
    text = msg["text"]
    if woof.norm is not None:
        text = woof.norm(text)
    # Same steps as Woof.__call__, but each piece is sent as soon as it is
    # made, so playback can start before the whole text is done.
    for piece in split_text(text) or [text]:
        if cancelled():
            break
        emit(woof._piece(piece))


worker_base.serve({"sr": SR, "voices": list(VOICES)}, voice_model, speak)
