---
name: bosca-ceoil-composer
description: Compose original game music and sound effects with the Bosca Ceoil MCP, and export them ready for a game. Use this whenever the user wants a soundtrack, background music, battle or menu theme, seamless loop, jingle, sting, UI sound, or SFX such as a coin, jump, laser, hit or explosion, and the bosca-ceoil tools are available, even if they don't mention Bosca Ceoil. Also use it for chiptune or retro game audio, and for fixing or extending a .ceol song.
---

# Bosca Ceoil Composer

Write original music and sound effects for games in Bosca Ceoil Blue, then export files a game can use.

This skill drives the bosca-ceoil MCP server. If its tools aren't available, tell the user to set it up from https://github.com/boraswim/bosca-ceoil-mcp, which also needs Node.js 18+ and the free Bosca Ceoil Blue app, and stop there.

You can't hear anything you make. Measurements catch technical faults, like silence, clipping, the wrong length or a bad loop seam, but they can't tell you whether something sounds good. Only the user can judge that, so always ask them to listen and never claim that a result sounds good.

## Start with the brief

Work out these from the request, and only ask about what you can't sensibly assume:

- **Use:** which game moment it's for, and whether it loops, plays once or layers over other audio.
- **Mood and style:** the game's genre and any references. Treat a named game or song as a description of its feel, and don't reuse its melodies.
- **Delivery:** the folder to write to, and for music, the length in bars or seconds.

State the assumptions you made in your final message.

Before replacing anything, call `app_status`. If the open song has unsaved changes that aren't yours, save it or ask the user first. `discard_changes` exists to protect their work, so only set it for your own test songs.

Read the reference file for the job:

- **Sound effects:** [references/sfx-recipes.md](references/sfx-recipes.md)
- **Music:** [references/music-by-context.md](references/music-by-context.md)
- **Unexpected engine behaviour, or a sound you need to shape:** [references/bosca-behaviour.md](references/bosca-behaviour.md)
- **Finding more reference material:** [references/sources.md](references/sources.md)

## Stay original

Reference material teaches technique, such as tempo, density, form and how a sound's pitch moves. Never reproduce a recognisable melody, riff or signature sound, even when the user names one, because a game shipping a copy creates a real problem for them. If asked for "the Mario coin sound", make a new sound with a similar function, say that you did, and avoid the original's exact notes.

## Sound effect workflow

1. Pick a recipe and its target measurements.
2. Build it with `create_song`: 450 BPM, pattern size 16, scale `normal`, and no effect unless the recipe asks for one. One step is then 33 ms, the shortest time the app can resolve.
3. Add automation with `update_pattern` if the recipe uses it. It only applies when a note starts, so shape a sound with a run of one-step notes, not a held note.
4. End the song with an empty pattern so any tail isn't cut off.
5. Export to WAV, then run `scripts/finish_sfx.py` to trim silence and set the level.
6. Run `scripts/analyze_audio.py` and compare the result to the recipe's targets. Adjust and export again if they're clearly off.
7. Make 2 or 3 variations when the sound will repeat often in the game, such as footsteps or hits, because identical repeats are tiring to hear. Change the pitch by a few semitones or the length by a step.
8. Call `save_song` so the user keeps an editable `.ceol` file next to the WAV. Do this before starting another song, because `create_song` replaces the open one.

To make several sounds without effects in one song, put each in its own bar with empty bars after it, then use `from_bar` and `to_bar` on `export_song`. One `.ceol` file then holds the whole set. Each sound that needs a different effect needs its own song, because an effect applies to the whole song.

## Music workflow

1. Choose the tempo, mode, palette and form from the context table.
2. Write 2 to 4 bars of the core idea first: bass and harmony, then the melody, then drums.
3. Build the arrangement from reused patterns with small changes, like a drum fill or a different melody ending every 4th or 8th bar. Real game tracks repeat a lot, and it also keeps files small and stops listeners tiring of a track.
4. Use `get_song` to confirm the notes and arrangement landed as intended.
5. **For a loop,** arrange the loop twice and add one empty bar at the end, then export and cut it with `scripts/extract_loop.py`. This is what makes the seam clean. See "Loops" in the music reference.
6. Run `scripts/analyze_audio.py` with `--loop` on the result. Fix clipping by lowering instrument volumes, not by accepting it.
7. Call `save_song` so the user keeps an editable `.ceol` file next to the WAV.

Check for peak below 0 dB with no clipped samples, and an RMS around -20 to -14 dB for full-mix music. Calm tracks can sit lower, around -25 dB. These are starting points, since the user's game mix decides the final level.

## Finish

- Tell the user where each file is, and which tempo, key and loop length you used.
- Report measurements only as technical checks.
- Call `play` when the user is ready to listen, and ask what to change. Ask specific questions, such as whether it's too bright or too long.
- Mention that Ctrl+Z in the app undoes each edit.

## Demos

`assets/demos/` holds examples made with this skill. Use them to check what a finished file should look like: run `scripts/analyze_audio.py` on a demo and compare its numbers with your own export, for example if a result seems too quiet or too bright. They aren't templates, so don't reuse their notes in a new piece.

- `sfx/`: one WAV for each recipe in [references/sfx-recipes.md](references/sfx-recipes.md), which lists how each was built.
- `music/battle_loop.wav`: 132 BPM, A harmonic minor, 4-bar loop, with bass, lead, arpeggio and drums.
- `music/menu_loop.wav` and `menu_loop.ceol`: 84 BPM, D major, 8-bar loop, with bass, arpeggio and vibraphone.

## Scripts

All three need Python 3. `analyze_audio.py` and `finish_sfx.py` also need numpy, while `extract_loop.py` uses only the standard library.

```text
scripts/analyze_audio.py FILE [FILE ...] [--loop] [--json]
scripts/finish_sfx.py IN.wav OUT.wav [--peak-db -3] [--tail-ms 10]
scripts/extract_loop.py IN.wav OUT.wav --bpm N --pattern-size N --bars N [--intro-bars N]
```

In `analyze_audio.py`, `pitch` is only meaningful when `tonal_fraction` is high, so ignore it for noise-based sounds. `level_jump_db` in a loop's report is normal when a kick lands on the downbeat, so a seam fault shows up as a high `sample_jump`, roughly above 0.2.
