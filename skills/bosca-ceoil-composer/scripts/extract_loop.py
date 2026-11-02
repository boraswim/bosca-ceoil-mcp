#!/usr/bin/env python3
"""Cut a seamless game loop out of a WAV rendered from a song that plays its loop twice.

Rendering the loop twice means the second pass starts with the first pass's
reverb and delay tail, the same tail that will ring over the seam in the game.
This keeps exactly the second pass, sized from the tempo so the loop can't drift.

Usage:
  extract_loop.py IN.wav OUT.wav --bpm 128 --pattern-size 16 --bars 8 [--intro-bars 0]

--bars is one pass of the loop; --intro-bars is anything before the first pass.
Needs numpy only if you also run analyze_audio.py on the result.
"""
import argparse
import sys
import wave


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--pattern-size", type=int, required=True)
    ap.add_argument("--bars", type=int, required=True)
    ap.add_argument("--intro-bars", type=int, default=0)
    a = ap.parse_args()

    with wave.open(a.input, "rb") as w:
        params = w.getparams()
        sr, frame = w.getframerate(), w.getnchannels() * w.getsampwidth()
        total = w.getnframes()
        data = w.readframes(total)

    bar_frames = 60.0 / a.bpm / 4 * a.pattern_size * sr
    start = round((a.intro_bars + a.bars) * bar_frames)
    end = round((a.intro_bars + 2 * a.bars) * bar_frames)
    if end > total:
        short = (end - total) / sr
        if short > 0.1:
            print(f"error: render is {short:.3f}s shorter than two passes. "
                  "Add an empty bar after the second pass and export again.", file=sys.stderr)
            return 1
        print(f"error: the render ends {short:.3f}s before the second pass does, because exports "
              "run slightly short. Add an empty bar after the second pass and export again.",
              file=sys.stderr)
        return 1

    with wave.open(a.output, "wb") as w:
        w.setparams(params)
        w.writeframes(data[start * frame:end * frame])
    print(f"wrote {a.output}: {(end - start) / sr:.3f}s, {end - start} frames at {sr} Hz")
    return 0


if __name__ == "__main__":
    sys.exit(main())
