#!/usr/bin/env python3
"""Measure exported audio so a composer who can't hear it can still check it.

Usage:
  analyze_audio.py FILE [FILE ...] [--json]
  analyze_audio.py LOOP.wav --loop      also compare the loop's start and end

Needs numpy. Reads WAV by itself; other formats need the soundfile package.
Duration ignores trailing silence, so export padding doesn't hide a short sound.
"""
import argparse
import json
import os
import sys
import wave

import numpy as np

SILENCE_DB = -50.0


def load(path):
    if path.lower().endswith(".wav"):
        with wave.open(path, "rb") as w:
            sw, ch, sr, n = w.getsampwidth(), w.getnchannels(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
        if sw == 2:
            x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768
        elif sw == 3:
            b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
            v = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
            x = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float64) / (1 << 23)
        elif sw == 1:
            x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128) / 128
        else:
            raise ValueError(f"unsupported sample width {sw}")
        x = x.reshape(-1, ch)
    else:
        import soundfile
        x, sr = soundfile.read(path, always_2d=True, dtype="float64")
    return x.mean(axis=1), sr, x


def db(v):
    return float(20 * np.log10(max(v, 1e-9)))


def frames(x, size, hop):
    if len(x) < size:
        x = np.pad(x, (0, size - len(x)))
    n = 1 + (len(x) - size) // hop
    return np.stack([x[i * hop:i * hop + size] for i in range(n)])


def pitch(frame, sr):
    """Autocorrelation pitch in Hz, or None when the frame isn't clearly tonal."""
    f = frame - frame.mean()
    if np.sqrt(np.mean(f ** 2)) < 1e-3:
        return None
    spec = np.fft.rfft(f * np.hanning(len(f)), 2 * len(f))
    ac = np.fft.irfft(np.abs(spec) ** 2)[:len(f)]
    if ac[0] <= 0:
        return None
    lo, hi = int(sr / 4000), min(int(sr / 50), len(ac) - 1)
    if hi <= lo:
        return None
    window = ac[lo:hi]
    best = float(window.max())
    if best / ac[0] <= 0.5:
        return None
    # A period's multiples score about as high, so take the first peak near the best.
    for i in range(lo + 1, hi - 1):
        if ac[i] >= best * 0.9 and ac[i] >= ac[i - 1] and ac[i] >= ac[i + 1]:
            return float(sr / i)
    return None


def note_name(hz):
    if not hz:
        return None
    m = int(round(69 + 12 * np.log2(hz / 440)))
    return "C C# D D# E F F# G G# A A# B".split()[m % 12] + str(m // 12 - 1)


def analyze(path):
    x, sr, stereo = load(path)
    out = {"file": os.path.basename(path), "total_s": round(len(x) / sr, 3), "sample_rate": sr}
    peak = float(np.max(np.abs(stereo))) if len(x) else 0
    out["peak_db"] = round(db(peak), 1)
    out["clipped_samples"] = int(np.sum(np.abs(stereo) >= 0.999))
    if peak < 1e-4:
        out["silent"] = True
        return out
    size, hop = int(sr * 0.02), max(1, int(sr * 0.005))
    env = np.sqrt(np.mean(frames(x, size, hop) ** 2, axis=1))
    env_db = 20 * np.log10(np.maximum(env, 1e-9))
    top = float(env.max())
    audible = np.where(env_db > max(SILENCE_DB, db(top) - 45))[0]
    first, last = int(audible[0]), int(audible[-1])
    t = lambda i: i * hop / sr
    pk = int(np.argmax(env))
    out["lead_silence_s"] = round(t(first), 3)
    out["sound_s"] = round(t(last) - t(first) + size / sr, 3)
    out["trail_silence_s"] = round(max(0.0, len(x) / sr - t(last) - size / sr), 3)
    out["rms_db"] = round(db(float(np.sqrt(np.mean(x[first * hop:(last + 1) * hop + size] ** 2)))), 1)
    out["crest_db"] = round(db(peak) - out["rms_db"], 1)
    out["attack_ms"] = round((t(pk) - t(first)) * 1000)
    tail = env[pk:last + 1]
    below = np.where(tail < top * 0.1)[0]
    out["decay_to_-20db_ms"] = round(t(int(below[0])) * 1000) if len(below) else None

    fsize = min(2048, max(256, (last - first) * hop + size))
    seg = x[first * hop:(last + 1) * hop + size]
    fr = frames(seg, fsize, max(1, fsize // 2)) * np.hanning(fsize)
    mag = np.abs(np.fft.rfft(fr, axis=1)) + 1e-12
    freqs = np.fft.rfftfreq(fsize, 1 / sr)
    energy = mag.sum(axis=1)
    keep = energy > energy.max() * 0.03
    centroid = (mag * freqs).sum(axis=1) / energy
    flat = np.exp(np.log(mag[:, 1:]).mean(axis=1)) / mag[:, 1:].mean(axis=1)
    c = centroid[keep]
    out["brightness_hz"] = {"start": round(float(c[0])), "median": round(float(np.median(c))), "end": round(float(c[-1]))}
    out["noisiness"] = round(float(np.median(flat[keep])), 3)

    psize = min(int(sr * 0.04), len(seg))
    tracks = []
    for f in frames(seg, psize, max(1, int(sr * 0.01))):
        tracks.append(pitch(f, sr))
    found = [p for p in tracks if p]
    out["tonal_fraction"] = round(len(found) / max(1, len(tracks)), 2)
    if len(found) >= 2:
        n = max(1, len(found) // 5)
        a, b = float(np.median(found[:n])), float(np.median(found[-n:]))
        out["pitch"] = {"start": note_name(a), "end": note_name(b),
                        "semitones": round(float(12 * np.log2(b / a)), 1),
                        "low": note_name(min(found)), "high": note_name(max(found))}
    return out


def loop_seam(path):
    """Compare the two sides of the wrap point. A loop should have no jump there."""
    x, sr, _ = load(path)
    n = int(sr * 0.1)
    if len(x) < n * 4:
        return {"note": "too short to judge"}
    a, b = x[-n:], x[:n]
    ra, rb = np.sqrt(np.mean(a ** 2)), np.sqrt(np.mean(b ** 2))
    return {"end_rms_db": round(db(float(ra)), 1), "start_rms_db": round(db(float(rb)), 1),
            "level_jump_db": round(abs(db(float(ra)) - db(float(rb))), 1),
            "sample_jump": round(abs(float(x[-1] - x[0])), 3)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    results = []
    for f in a.files:
        r = analyze(f)
        if a.loop:
            r["loop"] = loop_seam(f)
        results.append(r)
    for r in results:
        print(json.dumps(r, indent=None if not a.json else 2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
