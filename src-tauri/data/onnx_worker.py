"""Worker process for tts-bench: runs ONNX models (Kitten TTS 0.8 and Kokoro).

Started by the app as: python onnx_worker.py <kitten|kokoro> <model folder>
Protocol: see worker_base.py. The model is loaded before READY is sent, so the
app's "load time" covers Python start-up, imports and the model itself.
"""
import json
import os
import re
import sys

import numpy as np

import worker_base

SR = 24000
kind, folder = sys.argv[1], sys.argv[2]


def sentences(text, min_len=20):
    """Sentences, with very short ones joined to the next so speech isn't choppy."""
    out = []
    for s in re.split(r"(?<=[.!?…])\s+", text.strip()):
        if not s:
            continue
        if out and len(out[-1]) < min_len:
            out[-1] += " " + s
        else:
            out.append(s)
    return out or [text]


def build_kitten():
    from kittenml.kittentts_legacy.onnx_model import KittenTTS_1_Onnx

    with open(os.path.join(folder, "config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    model = KittenTTS_1_Onnx(
        os.path.join(folder, cfg["model_file"]),
        os.path.join(folder, cfg["voices"]),
        cfg.get("speed_priors", {}),
        cfg.get("voice_aliases", {}),
        backend="cpu",
    )

    def speak(msg, emit, cancelled):
        # generate_stream cleans the text (numbers, currency...) and yields one array per chunk.
        for chunk in model.generate_stream(msg["text"], voice=msg["voice"], speed=1.0):
            if cancelled():
                break
            emit(chunk)

    return speak


def build_kokoro():
    from kokoro_onnx import Kokoro

    model_file = "kokoro-v1.0.onnx"
    model = Kokoro(os.path.join(folder, model_file), os.path.join(folder, "voices-v1.0.bin"))

    def speak(msg, emit, cancelled):
        voice = msg["voice"]
        lang = "en-gb" if voice.startswith("b") else "en-us"
        # One sentence at a time, so the first one can play while the rest are made.
        for piece in sentences(msg["text"]):
            if cancelled():
                break
            samples, _rate = model.create(piece, voice=voice, speed=1.0, lang=lang)
            emit(samples)

    return speak


speak = {"kitten": build_kitten, "kokoro": build_kokoro}[kind]()
worker_base.serve({"sr": SR}, lambda voice: None, speak)
