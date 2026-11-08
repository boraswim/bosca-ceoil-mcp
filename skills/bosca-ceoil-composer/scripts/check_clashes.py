"""Find simultaneous pitched notes a semitone apart (minor 2nd, major 7th, minor 9th...) in a MIDI file.

Usage: clash_check.py FILE.mid [--ticks-per-step N]
Prints each clash with bar, step, the two notes and their tracks/channels. Drum channel 10 is skipped.
"""
import struct
import sys
from collections import defaultdict

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def nn(n):
    return f"{NAMES[n % 12]}{n // 12 - 1}"


def read_varlen(data, i):
    v = 0
    while True:
        b = data[i]
        i += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, i


def parse(path):
    data = open(path, "rb").read()
    assert data[:4] == b"MThd"
    hlen = struct.unpack(">I", data[4:8])[0]
    _fmt, ntrk, division = struct.unpack(">HHH", data[8:14])
    i = 8 + hlen
    notes = []  # (start, end, pitch, track, channel)
    for t in range(ntrk):
        assert data[i:i + 4] == b"MTrk", data[i:i + 4]
        tlen = struct.unpack(">I", data[i + 4:i + 8])[0]
        j, end = i + 8, i + 8 + tlen
        tick, status = 0, 0
        on = {}
        while j < end:
            dt, j = read_varlen(data, j)
            tick += dt
            b = data[j]
            if b == 0xFF:
                ln, j2 = read_varlen(data, j + 2)
                j = j2 + ln
                continue
            if b in (0xF0, 0xF7):
                ln, j2 = read_varlen(data, j + 1)
                j = j2 + ln
                continue
            if b & 0x80:
                status = b
                j += 1
            kind, ch = status & 0xF0, status & 0x0F
            if kind in (0x80, 0x90):
                p, v = data[j], data[j + 1]
                j += 2
                key = (ch, p)
                if kind == 0x90 and v > 0:
                    on.setdefault(key, []).append(tick)
                elif on.get(key):
                    s = on[key].pop(0)
                    notes.append((s, tick, p, t, ch))
            elif kind in (0xC0, 0xD0):
                j += 1
            else:
                j += 2
        i = end
    return notes, division


def main():
    path = sys.argv[1]
    notes, division = parse(path)
    step = division // 4  # 16th note
    pitched = [n for n in notes if n[4] != 9]
    by_step = defaultdict(list)
    for s, e, p, t, ch in pitched:
        for k in range(s // step, max(s // step + 1, (e + step - 1) // step)):
            by_step[k].append((p, t, ch, s // step == k))
    seen = set()
    count = 0
    for k in sorted(by_step):
        group = by_step[k]
        for a in range(len(group)):
            for b in range(a + 1, len(group)):
                pa, ta, ca, sa = group[a]
                pb, tb, cb, sb = group[b]
                if (ta, ca) == (tb, cb):
                    continue
                if abs(pa - pb) % 12 in (1, 11) and (sa or sb):
                    lo, hi = sorted((pa, pb))
                    key = (k, lo, hi)
                    if key in seen:
                        continue
                    seen.add(key)
                    count += 1
                    print(f"bar {k // 16:2d} step {k % 16:2d}: {nn(lo)} (trk{ta if lo == pa else tb}) vs {nn(hi)} (trk{tb if lo == pa else ta}), {hi - lo} semitones")
    tracks = sorted({(t, ch) for _, _, _, t, ch in pitched})
    print(f"{count} clashes; pitched tracks/channels: {tracks}")


if __name__ == "__main__":
    main()
