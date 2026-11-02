# Music by game context

## Tempo by feel

BPM ranges from 1,196 pieces in Kevin MacLeod's Incompetech catalogue, grouped by the catalogue's own feel tags. The range is the middle half of each group, with the median in the middle column. The game contexts on the right are a judgement call, not catalogue data.

| Feel | Low | Median | High | Often fits |
|---|---|---|---|---|
| Somber | 56 | 68 | 85 | Game over, sad story beat |
| Calming | 64 | 80 | 104 | Title screen, safe area, save room |
| Relaxed | 70 | 88 | 105 | Menu, village, puzzle |
| Mystical | 70 | 90 | 112 | Magic area, shrine |
| Eerie | 70 | 90 | 120 | Horror, abandoned place |
| Mysterious | 75 | 93 | 118 | Exploration, cave, investigation |
| Unnerving | 80 | 95 | 120 | Horror chase build-up |
| Dark | 77 | 98 | 124 | Villain, dungeon |
| Suspenseful | 84 | 102 | 126 | Stealth, approaching danger |
| Uplifting | 76 | 104 | 124 | Victory, level complete, ending |
| Epic | 76 | 104 | 130 | Boss intro, final area |
| Grooving | 90 | 107 | 124 | Shop, hub, driving |
| Intense | 91 | 116 | 135 | Battle, timed challenge |
| Bright | 95 | 117 | 135 | Overworld, platformer level |
| Driving | 104 | 120 | 138 | Racing, chase, action level |
| Bouncy | 100 | 120 | 142 | Platformer, casual game |
| Humorous | 94 | 120 | 144 | Comedy, minigame |
| Aggressive | 97 | 122 | 140 | Boss, heavy combat |
| Action | 105 | 126 | 140 | Battle, action set piece |

Faster tags sit together between 116 and 126, so tempo alone doesn't set the mood. Mode, voices and rhythm do the rest. Battles and bosses often sound more urgent with double-time drums rather than a higher BPM.

## Mode and harmony

| Mood | Try | Why |
|---|---|---|
| Bright, playful | Major, or `pentatonic major` | Hard to write a wrong note, and it stays cheerful |
| Tense, heroic | `harmonic minor` | The raised 7th gives a strong pull back to the root |
| Sad, reflective | Natural minor (relative major's key with scale `major`) | Softer than harmonic minor |
| Mysterious, floating | `pentatonic minor`, or sparse notes over a held bass | Little harmonic direction, so it doesn't resolve |
| Unsettling | Scale `normal`, using tritones and semitone clashes | Avoid a clear key centre |

Changing the chord once per bar is a safe default. Slow tracks can stay on one chord for 2 to 4 bars, and busy ones can change twice per bar at a turnaround.

## Arrangement

Measured from 16 hand-written MIDI pieces made for games (CC0). That's a small sample, so use these as a starting point:

- **Parts:** 2 to 5 channels, typically 4. Bosca's limit of 8 is plenty.
- **Density:** typically about 26 notes per bar across all parts, including 17 drum hits. Calm tracks go far lower, around 9 notes per bar.
- **Register:** the bass part centres around F#1 to B2, and the top part around D#4 to A4.
- **Repetition:** typically about half of all bars are exact repeats, and some tracks repeat over 70%.
- **Grid:** nearly all notes fall on a 16th step, so a 16-step pattern loses very little. Use a pattern size of 12 or 24 for triplet feels.
- **Mode:** 10 minor and 6 major.
- **Length:** typically 36 bars, and about 75 seconds.

## Roles and palette

Give each part its own register and rhythm so they don't blur together. All voices are listed in [bosca-behaviour.md](bosca-behaviour.md).

- **Bass:** root notes and 5ths in steady rhythm. Set the groove here.
- **Harmony:** arpeggios on a soft voice like Triangle Wave at a lower volume.
- **Lead:** a short, singable idea, with space to breathe. Rest for a beat or two every couple of bars.
- **Drums:** kick and snare set the feel, hi-hats set the speed. Add a fill on the last bar of each phrase.

## Forms for games

| Use | Form | Typical length |
|---|---|---|
| Background loop | A A′ B A′, all looping | 8 to 32 bars |
| Battle | Short intro, then a loop of A and B | 16 to 32 bars |
| Menu or title | A soft 8 or 16-bar loop with little percussion | 8 to 16 bars |
| Horror or ambience | Sparse notes with long gaps and no steady drums | 8 to 16 bars |
| Victory jingle | Rising figure ending on a held tonic; doesn't loop | 1 to 3 seconds |
| Game over | Falling figure ending low, doesn't loop | 2 to 4 seconds |

A jingle should end on the key's root, and at a tempo that can stand alone. Treat it like a sound effect, with a fresh empty bar at the end.

## Loops

A good game loop has no audible join. Writing it well matters more than cutting it well:

1. **Write the seam.** Make the last bar lead back to the first, using a fill or the chord that resolves to the opening one.
2. **Don't leave long notes hanging.** Notes that run past the last bar will be cut off in the app's own loop.
3. **Arrange it twice,** with one empty pattern in the bar after. For a 4-bar loop, that's 9 bars.
4. **Export and cut.** `scripts/extract_loop.py IN.wav OUT.wav --bpm N --pattern-size N --bars 4` keeps exactly the second pass. It starts with the reverb tail of the first pass, so the seam matches what plays when the game wraps around.
5. **Check it** with `analyze_audio.py OUT.wav --loop`.

When there's an intro that doesn't repeat, arrange the intro, then the loop twice, and pass `--intro-bars`. Export the intro separately so the game can play it once before starting the loop.

Tell the user the exact loop length and that the WAV has no padding. Many game engines add a gap when looping compressed formats like MP3, so WAV or OGG is the safer choice.

## Layered music

If the game raises intensity by adding layers, write all layers to the same length and export each with the other channels removed from the arrangement. Keep the same effect and power across them so their tails match. Call `save_song` first, since this edits the arrangement. This approach hasn't been tested yet, so check that the layers line up.
