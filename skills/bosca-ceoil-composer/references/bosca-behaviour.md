# How Bosca Ceoil behaves

Measured from renders in Bosca Ceoil Blue 3.1.2 through the MCP. A later app version could differ, so re-measure if results look wrong.

## Timing

- One step is `60 / bpm / 4` seconds. At the 450 BPM maximum, that's 33 ms.
- A note sounds for its written length plus about 20 ms of release, so 8 steps at 450 BPM measured 284 ms.
- A bar is `pattern_size` steps. Rendered timing matched the tempo to within a sample over 4 bars.
- Bars at the end of a song with no patterns are dropped, even if you pass `[null]` for them. Use an empty pattern to keep a bar.
- A normal render ends up to about 40 ms before the song's nominal length, and a `fast` render 10 to 40 ms after it. This is why a loop needs an empty bar after it, so that `extract_loop.py` always has the full second pass.
- The render stops dead at the end of the song, cutting off any reverb or delay tail. An empty pattern in the last few bars keeps the tail.

## Automation only applies when a note starts

With `record_filter` on, `filter_steps` values apply when a note begins. They don't change a note that's already playing:

- A held 16-step note stayed at its first step's volume and cutoff for its whole length.
- 16 one-step notes followed the volume and cutoff curve correctly.

So to fade or sweep a sound, write a run of one-step notes with a value on every step. This works well on noise. On a pitched voice, the repeated notes can add a slight buzz at the step rate.

Only the first 16 steps of automation survive saving. To shape something longer, use pattern size 16 and chain patterns across bars, since each pattern has its own 16 steps.

## Filter cutoff

Median brightness (spectral centroid) measured for each `cutoff` value:

| Cutoff | Square wave, C5 | Noise, C4 |
|---|---|---|
| 128 | 6700 Hz | 7400 Hz |
| 96 | 3200 Hz | |
| 80 | | 3000 Hz |
| 64 | 1500 Hz | 2100 Hz |
| 40 | 720 Hz | 1000 Hz |
| 24 | 630 Hz, and about 13 dB quieter | |
| 20 | | 390 Hz, and about 11 dB quieter |

Unfiltered chiptune voices are much brighter than typical game UI sounds, which measured about 2000 to 4000 Hz. Start square and saw voices at cutoff 80 to 96 for short sounds.

Other voices at C5, with no filter: Triangle Wave 1270 Hz, Sine Wave 705 Hz.

## Volume and level

- `volume` is linear: halving it from 256 to 128 lowers the level by 6 dB, and 64 by 12 dB.
- A single chiptune voice at full volume peaks around -15 to -9 dB, so one-voice sounds come out quiet. `scripts/finish_sfx.py` raises them.
- `CHIPTUNE/Pulse Wave` is thin, measuring about 16 dB lower in RMS than a square wave in a short sweep. Prefer `CHIPTUNE/Square Wave` unless you want that thin sound.
- A 4-part arrangement with bass and drums at 200 to 256 volume peaked at -1.8 dB with no clipping, so that's near the ceiling. Keep some margin when adding parts.

## Voices

`list_voices` shows over 300 voices. Filter by category: MIDI, CHIPTUNE, BASS, BRASS, BELL, GUITAR, LEAD, PIANO, SPECIAL, STRINGS, WIND, WORLD, DRUMKIT.

| Role | Voices to try first |
|---|---|
| Retro lead | `CHIPTUNE/Square Wave`, `CHIPTUNE/Dual Square`, `LEAD/Synth PSG`, `LEAD/PSG Cut 1` |
| Soft lead or arpeggio | `CHIPTUNE/Triangle Wave`, `CHIPTUNE/Sine Wave`, `LEAD/Sin Water Synth` |
| Bright or aggressive lead | `CHIPTUNE/Saw Wave`, `CHIPTUNE/Dual Saw`, `LEAD/Metal Lead`, `LEAD/Attack Synth` |
| Bass | `BASS/PSG Bass 1`, `BASS/Synth Bass 1`, `BASS/Analog Bass #2`, `BASS/Low Bass x1` |
| Bells and magic | `BELL/Glocken 1`, `BELL/Kirakira`, `BELL/Pretty Bell`, `BELL/Vibraphone`, `BELL/Marimba` |
| Noise and effects | `CHIPTUNE/Noise`, `CHIPTUNE/Noise (Bass)`, `CHIPTUNE/Noise (Snare)`, `CHIPTUNE/Noise (Hi-Hat)`, `SPECIAL/Effect 3 (FB + Noise)` |

Only some of these have been measured, and voices sit at different levels, so check a new voice with `analyze_audio.py`.

`CHIPTUNE/Noise (Bass)` is very dark and decays by itself in about 400 ms, so it suits the low layer of an impact.

### Use one bass voice

Don't layer two bass voices at the same pitch. In a funk song, layering clashed in two ways:

- `BASS/Low Bass x1` isn't a clean sub. On E1 it also sounded a strong B1 (a fifth up), and on C2 a C1 (an octave down), so against a moving bass line it made a muddy cluster.
- A `CHIPTUNE/Sine Wave` doubling `MIDI/Slap Bass 1` note for note cancelled the slap's fundamental. The pair measured about 2 dB less below 120 Hz than the slap alone.

For a heavier bass, pick one heavier voice instead. Measured on the same one-bar line at volume 256, below 120 Hz:

| Voice | Below 120 Hz | 600 Hz to 3 kHz | Character |
|---|---|---|---|
| `BASS/Analog Groove #2` | -13.5 dB | -65 dB | Heavy synth sub, little attack; volume around 150 in a full mix |
| `BASS/Groove Bass #1` | -18.5 dB | -69 dB | Similar, a bit lighter |
| `MIDI/Finger Bass` | -25.0 dB | -40 dB | Warm, with the most body (120 to 600 Hz) |
| `MIDI/Slap Bass 1` | -28.1 dB | -31 dB | Light low end, the most click |

The synth basses have almost nothing above 600 Hz, so they may fade on laptop speakers.

`MIDI/Finger Bass` has very strong overtones. On a held C2, its 3rd harmonic (G3) was louder than the note itself, and its 5th harmonic (E4) was only 6 dB down. Under a minor chord that 5th harmonic is a major 3rd, which rubs against the chord. Instrument `cutoff` 16 brought the 5th harmonic down to -23 dB, while cutoff 40 changed nothing, because these overtones sit below 400 Hz.

### Voices that sound in another octave

`MIDI/Drawbar Organ` has a strong sub-octave: a written C5 was loudest at C4. A melody written above the chords can therefore land inside the chords' register. `MIDI/Percussive Organ` has only octave partials (C4 -5 dB, C5 -3 dB, C6 0 dB) and no strong 5th, so it suits a lead over chords better. Check an unfamiliar voice by rendering one held note and looking at its spectrum before writing parts around it.

## Drumkits

Drumkit patterns take item names as notes. Call `get_drumkit` for the full list.

- `DRUMKIT/Simple Drumkit` (8 items): `Bass Drum 1`, `Bass Drum 2`, `Bass Drum 3`, `Snare Drum`, `Snare Drum 2`, `Open Hi-Hat`, `Closed Hi-Hat`, `Crash Cymbal`
- `DRUMKIT/SiON Drumkit` (38 items): includes 808 kicks and snares, toms, cowbell and metal hi-hats
- `DRUMKIT/MIDI Drumkit` (61 items)

Drums can be useful for sound effects too: a kick plus a noise layer makes a quick impact.

## Effects

There's one effect per song: delay, chorus, reverb, distortion, low boost, compressor or high pass. `effect_power` runs from 0 to 130, and 5 or lower turns it off.

Reverb tails are long, falling about 16 to 18 dB per second at power 30 to 60. Use little or none on short sounds unless the sound needs space, and always leave empty bars for the tail to ring out.

## Scales

- A pattern with any scale but `normal` rejects notes outside it, so use `normal` for sound effects.
- The app's `minor` is melodic minor, with a raised 6th and 7th. For natural minor, use the relative major's key with scale `major`.
- `harmonic minor` with the key's own name works directly, and it gives a raised 7th for a dark, tense sound.
