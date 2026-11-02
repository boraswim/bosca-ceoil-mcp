# Sound effect recipes

Every recipe assumes 450 BPM and pattern size 16, so one step is 33 ms. Use scale `normal`, and treat each as a starting point: move the pitches around so that sounds in one game don't all share the same notes.

Bosca suits retro, chiptune and stylised sounds. It can't produce convincing realistic sounds, like recorded footsteps, glass, doors or weather. If the user needs those, say so and offer a stylised version instead.

## What makes each kind of sound work

These patterns come from studying sfxr-style retro presets:

- **Attack:** almost every game sound starts instantly, so don't fade in.
- **Pickups** jump up quickly in pitch, then hold the top note.
- **Jumps** rise steadily over a moderate range.
- **Power-ups** rise further and for longer, often with repeated steps.
- **Lasers** fall fast over a wide range.
- **Hits** fall fast and end quickly, with noise for the body.
- **Explosions** are noise, starting bright and falling dark, with a long decay.
- **UI blips** are flat, short and fairly bright.

## Target measurements

Median values from 200 CC0 reference sounds, measured with `analyze_audio.py`. Treat these as ranges to land near, since a few categories have only a handful of sounds.

| Sound | Length | Brightness | Pitch movement |
|---|---|---|---|
| Click or tick | 20 ms | 3300–6200 Hz | none |
| Back or cancel | 70 ms | 2700 Hz | none |
| Toggle | 110 ms | 5700 Hz | up about 7 semitones |
| Select | 130 ms | 2600 Hz | up about 10 semitones |
| Switch | 150 ms | 2600 Hz | none |
| Error | 170 ms | 2700 Hz | none, tonal |
| Open or maximise | 250–310 ms | 3600 Hz or above | up 6–20 semitones |
| Close or minimise | 250–310 ms | 3600 Hz or above | down 5–18 semitones |
| Question | 330 ms | 1000 Hz | down about 7 semitones |
| Confirmation | 400 ms | 2100 Hz | up slightly, tonal |
| Hit | 140 ms | 3300 Hz | none |
| Heavy hit, wood | 260 ms | 1000 Hz | none |
| Heavy hit, metal | 350 ms | 5100 Hz | none |

## Recipes

Each of these was rendered and measured, but none has been judged by ear yet. Lengths are after trimming with `finish_sfx.py`.

### Coin or pickup: 310 ms

`CHIPTUNE/Square Wave`, cutoff 96.

Two notes rising a 5th, with the top one held: A5 for 2 steps, then E6 for 7 steps. Shift both notes for different items, and use a third note for rarer pickups.

### Jump: 250 ms

`CHIPTUNE/Square Wave`, cutoff 96.

One-step notes rising by whole tones, with a slightly longer last note: C5, D5, E5, F#5, G#5, then A#5 for 2 steps.

### Laser: about 280 ms

`CHIPTUNE/Square Wave`, cutoff 110.

One-step notes falling 3 semitones at a time: C7, A6, F#6, D#6, C6, A5, F#5, D#5. Use fewer steps for a quicker shot, or a lower start for a heavier gun.

### Explosion: about 800 ms

Two layers, spanning two bars:

- **Body:** `CHIPTUNE/Noise`, cutoff 128. Use one-step notes on C3 for 24 steps, 16 in the first pattern and 8 in the second, with automation on each.
- **Low end:** `CHIPTUNE/Noise (Bass)`, cutoff 60. One note on C2, 16 steps long, starting with the body.

Automation for the body, with one value per step:

| Pattern | Cutoff | Volume |
|---|---|---|
| First (16 steps) | 90, 84, 78, 72, 66, 60, 56, 52, 48, 44, 41, 38, 35, 32, 30, 28 | 256, 256, 244, 232, 220, 208, 196, 184, 172, 160, 148, 136, 124, 112, 100, 90 |
| Second (8 steps) | 26, 24, 23, 22, 21, 20, 20, 20 | 80, 70, 60, 50, 40, 28, 16, 8 |

This measured 2500 Hz falling to 245 Hz. Remember `record_filter: true` on both patterns. Add a little reverb and empty bars for a larger explosion, in a song of its own.

### Hit or damage: 150 ms

Two layers:

- `CHIPTUNE/Noise (Snare)`, cutoff 96: C4 for 2 steps.
- `CHIPTUNE/Square Wave`, cutoff 96: G4, E4, then C4 for 2 steps.

### UI click: 50 ms

`CHIPTUNE/Konami Wave`, cutoff 96: C6 for 1 step. This is the shortest sound the app can make, so it comes out longer than the 20 ms reference clicks. Lower the volume, since clicks repeat often.

### Confirm: 310 ms

`CHIPTUNE/Square Wave`, cutoff 96: E5 for 3 steps, then A5 for 6 steps.

### Error: 220 ms

`CHIPTUNE/Saw Wave`, cutoff 80: two stabs of C4 and F#4 together, with the tritone sounding wrong on purpose. Hold for 2 steps, rest for 1, then hold for 3.

### Power-up: 480 ms

`CHIPTUNE/Triangle Wave`: a major arpeggio climbing 2 steps per note: C5, E5, G5, C6, E6, then G6 for 4 steps. Use Square Wave at cutoff 96 for a harder edge.

## Building other sounds

Combine the ideas above, and name what you're aiming for before you start:

- **Whoosh or dash:** a run of one-step `CHIPTUNE/Noise` notes with cutoff rising then falling.
- **Magic or sparkle:** fast high notes on `BELL/Kirakira` or `BELL/Glocken 1`, with a little reverb.
- **Footstep (stylised):** one or two steps of filtered noise, with a low note under it.
- **Charge-up:** a long rising run, with volume automation climbing.
- **Death or fail:** a falling sequence, slower than a laser.
