#!/usr/bin/env python3
"""Make a rendered sound effect ready for a game: trim silence and set its peak level.

Usage:
  finish_sfx.py IN.wav OUT.wav [--peak-db -3] [--tail-ms 10]

Trims silence from both ends, leaving a short fade at the end so the cut can't
click, then scales the sound to the target peak. Needs numpy.
"""
import argparse
import sys
import wave

import numpy as np

THRESHOLD_DB = -60.0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--peak-db", type=float, default=-3.0)
    ap.add_argument("--tail-ms", type=float, default=10.0)
    a = ap.parse_args()

    with wave.open(a.input, "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        print(f"error: expected 16-bit audio, got {sw * 8}-bit", file=sys.stderr)
        return 1

    x = np.frombuffer(raw, dtype="<i2").astype(np.float64).reshape(-1, ch) / 32768
    level = np.abs(x).max(axis=1)
    peak = float(level.max()) if len(level) else 0.0
    if peak < 1e-4:
        print("error: the input is silent", file=sys.stderr)
        return 1

    keep = np.where(level > peak * 10 ** (THRESHOLD_DB / 20))[0]
    tail = int(sr * a.tail_ms / 1000)
    start, end = int(keep[0]), min(len(x), int(keep[-1]) + 1 + tail)
    y = x[start:end].copy()
    fade = min(tail, len(y))
    if fade:
        y[-fade:] *= np.linspace(1, 0, fade)[:, None]
    y *= 10 ** (a.peak_db / 20) / peak

    with wave.open(a.output, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(np.clip(np.round(y * 32767), -32768, 32767).astype("<i2").tobytes())
    print(f"wrote {a.output}: {len(y) / sr:.3f}s, peak {a.peak_db:.1f} dB, gain {a.peak_db - 20 * np.log10(peak):+.1f} dB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
