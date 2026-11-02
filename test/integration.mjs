// End-to-end test: a real MCP client, this server, and the real app without a window.
//
//   BOSCA_CEOIL_PATH=/path/to/boscaceoil-blue npm test
//
// Without BOSCA_CEOIL_PATH, it looks for the app in this repo's ref folder. The
// app's settings and the session file go to a temp folder, so nothing of the
// user's is touched.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "bosca-mcp-test-"));
const file = (name) => join(work, name);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js"), "--headless"],
  cwd: root,
  env: {
    ...process.env,
    BOSCA_CEOIL_PATH: process.env.BOSCA_CEOIL_PATH ?? join(root, "ref"),
    USERPROFILE: work,
    HOME: work,
    APPDATA: work,
    XDG_DATA_HOME: work,
  },
  stderr: "inherit",
});
const client = new Client({ name: "integration-test", version: "1.0.0" });

async function raw(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), text: result.content.map((part) => part.text ?? "").join("") };
}

async function call(name, args = {}) {
  const { isError, text } = await raw(name, args);
  assert.equal(isError, false, `${name} failed: ${text}`);
  return JSON.parse(text.split("\nNote:")[0]);
}

async function rejects(name, args, pattern) {
  const { isError, text } = await raw(name, args);
  assert.equal(isError, true, `${name} should have failed, but returned: ${text}`);
  assert.match(text, pattern);
}

let passed = 0;
async function test(name, body) {
  await body();
  passed++;
  console.log(`  ok - ${name}`);
}

const SONG = {
  bpm: 140,
  effect: "reverb",
  effect_power: 40,
  swing: 2,
  instruments: [
    { voice: "MIDI/Grand Piano", volume: 200 },
    { voice: "MIDI/Finger Bass", cutoff: 100, resonance: 2 },
    { voice: "DRUMKIT/Simple Drumkit" },
  ],
  patterns: [
    { instrument: 0, key: "C", scale: "major", notes: [{ note: "C4", pos: 0, len: 4 }, { note: "E4", pos: 4 }, { note: 67, pos: 8, len: 2 }] },
    { instrument: 1, key: "A", scale: "pentatonic minor", notes: [{ note: "A2", pos: 0, len: 8 }, { note: "C3", pos: 8, len: 8 }] },
    { instrument: 2, notes: [{ note: "Bass Drum 1", pos: 0 }, { note: "Snare Drum", pos: 4 }, { note: "Closed Hi-Hat", pos: 8 }, { note: "Snare Drum", pos: 12 }] },
  ],
  bars: [[0, 1, 2], [0, null, 2], [null, 1, 2], [0, 1, 2]],
};

try {
  await client.connect(transport);

  await test("lists tools, each with a description", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 25, `only ${tools.length} tools`);
    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} has no description`);
    }
    assert.ok(client.getInstructions()?.includes("step sequencer"));
  });

  await test("app_status doesn't start the app", async () => {
    assert.deepEqual(await call("app_status"), { running: false });
  });

  await test("launches the stock app and reports it", async () => {
    const status = await call("launch_app", { headless: true });
    assert.equal(status.headless, true);
    assert.equal(status.playback.playing, false, "the app shouldn't start out playing");
    assert.equal(status.song.instruments, 1);
    console.log(`    (Bosca Ceoil Blue ${status.version})`);
  });

  await test("finds voices and drumkit items", async () => {
    const all = await call("list_voices");
    assert.ok(all.count > 300);
    const bass = await call("list_voices", { query: "finger bass" });
    assert.equal(bass.voices[0].voice, "MIDI/Finger Bass");
    const kit = await call("get_drumkit", { voice: "DRUMKIT/Simple Drumkit" });
    assert.equal(kit.items.length, 8);
    await rejects("get_drumkit", { voice: "MIDI/Grand Piano" }, /not a drumkit/);
    await rejects("add_instrument", { voice: "does not exist" }, /No voice matches/);
    await rejects("add_instrument", { voice: "piano" }, /ambiguous/);
  });

  await test("builds a whole song in one call", async () => {
    await call("create_song", { ...SONG, discard_changes: true });
    const song = await call("get_song");
    assert.equal(song.bpm, 140);
    assert.equal(song.effect, "reverb");
    assert.equal(song.unsaved_changes, true);
    assert.equal(song.instruments[1].voice, "MIDI/Finger Bass");
    assert.equal(song.instruments[1].cutoff, 100);
    assert.equal(song.instruments[0].volume, 200);
    assert.deepEqual(song.patterns[0].notes, [
      { note: "C4", pos: 0, len: 4 },
      { note: "E4", pos: 4, len: 1 },
      { note: "G4", pos: 8, len: 2 },
    ]);
    assert.equal(song.patterns[1].key, "A");
    assert.equal(song.patterns[1].scale, "pentatonic minor");
    assert.equal(song.patterns[2].notes[1].note, "Snare Drum");
    assert.equal(song.arrangement.bars.length, 4);
    assert.deepEqual(song.arrangement.bars[1].slice(0, 3), [0, null, 2]);
    assert.equal(song.arrangement.loop_end, 4);
  });

  await test("rejects bad input without changing the song", async () => {
    const before = await call("get_song");
    await rejects("update_pattern", { pattern: 0, notes: [{ note: "C#4", pos: 0 }] }, /isn't in C major.*C major has: C, D, E, F, G, A, B\./);
    await rejects("update_pattern", { pattern: 1, scale: "minor", key: "A", notes: [{ note: "G4", pos: 0 }] }, /A minor has: A, B, C, D, E, F#, G#\./);
    await rejects("update_pattern", { pattern: 0, notes: [{ note: "C4", pos: 16 }] }, /outside the pattern/);
    await rejects("update_pattern", { pattern: 0, notes: [{ note: "H9", pos: 0 }] }, /not a valid note/);
    await rejects("update_pattern", { pattern: 0, notes: [{ note: "C4", pos: 0 }, { note: 60, pos: 0 }] }, /starts twice/);
    await rejects("update_pattern", { pattern: 2, notes: [{ note: "Cowbell", pos: 0 }] }, /not in the Simple Drumkit/);
    await rejects("update_pattern", { pattern: 99, notes: [] }, /Pattern 99 doesn't exist/);
    await rejects("edit_arrangement", { bars: [[42]] }, /pattern 42/);
    await rejects("edit_arrangement", { bars: [[0, 0, 0, 0, 0, 0, 0, 0, 0]] }, /limit is 8/);
    await rejects("create_song", { discard_changes: false }, /unsaved changes/);
    assert.deepEqual(await call("get_song"), before);
  });

  await test("edits notes, and undo and redo them", async () => {
    await call("update_pattern", { pattern: 0, notes: [{ note: "A4", pos: 12 }], notes_mode: "add" });
    let song = await call("get_song");
    assert.equal(song.patterns[0].note_count, 4);

    await call("undo");
    song = await call("get_song");
    assert.equal(song.patterns[0].note_count, 3);

    await call("redo");
    song = await call("get_song");
    assert.equal(song.patterns[0].note_count, 4);

    await call("update_pattern", { pattern: 0, notes: [{ note: "A4", pos: 12 }], notes_mode: "remove" });
    song = await call("get_song");
    assert.equal(song.patterns[0].note_count, 3);
    await rejects("update_pattern", { pattern: 0, notes: [{ note: "A4", pos: 12 }], notes_mode: "remove" }, /Couldn't find/);
  });

  await test("transposes with the key, and drops off-scale notes on a scale change", async () => {
    await call("add_pattern", { instrument: 0, notes: [{ note: "C4", pos: 0 }, { note: "C#4", pos: 1 }] });
    const index = (await call("get_song", { include_notes: false })).patterns.length - 1;

    await call("update_pattern", { pattern: index, key: "D" });
    let song = await call("get_song");
    assert.deepEqual(song.patterns[index].notes.map((n) => n.note), ["D4", "D#4"]);

    const changed = await call("update_pattern", { pattern: index, scale: "major" });
    assert.match(changed.warning, /1 notes/);
    song = await call("get_song");
    assert.deepEqual(song.patterns[index].notes.map((n) => n.note), ["D4"]);

    await call("undo");
    song = await call("get_song");
    assert.deepEqual(song.patterns[index].notes.map((n) => n.note), ["D4", "D#4"]);

    await call("remove_pattern", { pattern: index });
  });

  await test("changing a voice to a drumkit drops notes, and undo restores them", async () => {
    const changed = await call("update_instrument", { instrument: 1, voice: "DRUMKIT/Simple Drumkit" });
    assert.match(changed.warning, /2 notes/);
    let song = await call("get_song");
    assert.equal(song.patterns[1].note_count, 0);
    assert.equal(song.instruments[1].cutoff, 100, "settings should carry over to the new voice");

    await call("undo");
    song = await call("get_song");
    assert.equal(song.instruments[1].voice, "MIDI/Finger Bass");
    assert.equal(song.patterns[1].note_count, 2);
    assert.equal(song.patterns[1].key, "A");
  });

  await test("adds and removes instruments, shifting the indices", async () => {
    const added = await call("add_instrument", { voice: "MIDI/Violin" });
    assert.equal(added.index, 3);
    await call("undo");
    assert.equal((await call("get_song")).instruments.length, 3);
    await call("redo");

    await call("remove_instrument", { instrument: 3 });
    assert.equal((await call("get_song")).instruments.length, 3);

    const lastOnly = await call("get_song");
    assert.equal(lastOnly.patterns[2].instrument, 2);
  });

  await test("updates settings as one undo step", async () => {
    await call("update_song", { bpm: 90, swing: -3, effect: "delay", effect_power: 50 });
    let song = await call("get_song");
    assert.deepEqual([song.bpm, song.swing, song.effect, song.effect_power], [90, -3, "delay", 50]);
    await call("undo");
    song = await call("get_song");
    assert.deepEqual([song.bpm, song.swing, song.effect, song.effect_power], [140, 2, "reverb", 40]);
    await rejects("update_song", { effect: "flanger" }, /Unknown effect/);
  });

  await test("edits the arrangement and undoes it", async () => {
    await call("edit_arrangement", { at_bar: 4, bars: [[2], [2]] });
    let song = await call("get_song");
    assert.equal(song.arrangement.bars.length, 6);
    assert.equal(song.arrangement.loop_end, 6);
    await call("undo");
    song = await call("get_song");
    assert.equal(song.arrangement.bars.length, 4);
    assert.equal(song.arrangement.loop_end, 4);
  });

  await test("removing a pattern fixes the arrangement", async () => {
    const clone = await call("clone_pattern", { pattern: 2 });
    assert.equal(clone.index, 3);
    await call("edit_arrangement", { at_bar: 0, bars: [[3, 0]], loop_end: 4 });
    await call("remove_pattern", { pattern: 0 });
    let song = await call("get_song");
    assert.deepEqual(song.arrangement.bars[0].slice(0, 2), [2, null]);
    await call("undo");
    song = await call("get_song");
    assert.deepEqual(song.arrangement.bars[0].slice(0, 2), [3, 0]);
    await call("undo"); // The arrangement edit.
    await call("undo"); // The clone.
    assert.equal((await call("get_song")).patterns.length, 3);
  });

  await test("controls playback", async () => {
    await call("play", { from_bar: 1 });
    let status = await call("app_status");
    assert.equal(status.playback.playing, true);
    await call("pause");
    status = await call("app_status");
    assert.equal(status.playback.playing, false);
    assert.equal(status.playback.stopped, false);
    await call("stop");
    status = await call("app_status");
    assert.equal(status.playback.stopped, true);
    await rejects("play", { from_bar: 50 }, /outside the loop/);
  });

  await test("saves a file the app's format expects, and reads it back", async () => {
    const path = file("song.ceol");
    const before = await call("get_song");
    assert.equal((await call("save_song", { path })).file, path.replaceAll("\\", "/"));
    assert.equal((await call("get_song")).unsaved_changes, false);

    // Header per SongSaver: format, swing, effect, power, bpm, pattern size, bar size, instrument count.
    const fields = readFileSync(path, "utf8").split(",").slice(0, 8).map(Number);
    assert.deepEqual(fields, [3, 2, 2, 40, 140, 16, 4, 3]);

    await rejects("save_song", { path: file("song.txt") }, /\.ceol/);
    await call("save_song"); // Over its own file, which needs no confirmation.

    await call("create_song", {});
    await rejects("save_song", { path }, /already exists/);
    await rejects("open_song", { path }, /unsaved changes/);
    await call("open_song", { path, discard_changes: true });

    const after = await call("get_song");
    assert.equal(after.file, path.replaceAll("\\", "/"));
    assert.deepEqual({ ...after, file: "", unsaved_changes: false }, { ...before, file: "", unsaved_changes: false });
    await rejects("open_song", { path: file("missing.ceol") }, /No file/);
  });

  await test("exports MIDI, MML and XM", async () => {
    for (const format of ["mid", "mml", "xm"]) {
      const path = file(`song.${format}`);
      assert.equal((await call("export_song", { format, path })).state, "done");
      assert.ok(statSync(path).size > 0, `${format} is empty`);
      await rejects("export_song", { format, path }, /already exists/);
    }
    assert.equal(readFileSync(file("song.mid")).toString("latin1", 0, 4), "MThd");
    assert.ok(readFileSync(file("song.xm")).toString("latin1", 0, 17).startsWith("Extended Module"));
    await rejects("export_song", { format: "wav", path: file("x.mp3") }, /\.wav/);
    await rejects("export_song", { format: "wav", path: file("x.wav"), to_bar: 99 }, /bar range/);
    await rejects("export_song", { format: "wav", path: join(work, "missing", "x.wav") }, /folder doesn't exist/);
  });

  await test("renders a WAV with audio in it, and keeps the song's loop", async () => {
    const path = file("song.wav");
    await call("edit_arrangement", { bars: SONG.bars, loop_start: 1, loop_end: 3, replace_all: true });

    const started = Date.now();
    const job = await call("export_song", { format: "wav", path, from_bar: 0, to_bar: 4, wait_seconds: 120 });
    const seconds = (Date.now() - started) / 1000;
    console.log(`    (${job.duration_seconds}s of audio in ${seconds.toFixed(1)}s, peak ${job.peak}, rms ${job.rms})`);

    assert.equal(job.state, "done");
    assert.equal(job.silent, false, "the render is silent");
    assert.ok(job.rms > 0.005, `the render is suspiciously quiet: ${job.rms}`);

    // 4 bars of 16 steps, at 140 bpm with a step being a quarter of a beat.
    const expected = (4 * 16 * 60) / 140 / 4;
    assert.ok(job.duration_seconds >= expected && job.duration_seconds < expected + 3, `duration ${job.duration_seconds}, expected about ${expected}`);

    const song = await call("get_song");
    assert.deepEqual([song.arrangement.loop_start, song.arrangement.loop_end], [1, 3], "export changed the loop");
  });

  await test("can't edit while a WAV renders, and reports progress", async () => {
    const path = file("long.wav");
    const job = await call("export_song", { format: "wav", path, wait_seconds: 0 });
    assert.equal(job.state, "rendering");
    await rejects("update_song", { bpm: 100 }, /busy exporting/);
    assert.equal((await call("export_status")).state, "rendering");
    await call("get_song"); // Reading is fine.

    for (let i = 0; i < 240 && (await call("export_status")).state === "rendering"; i++) {
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal((await call("export_status")).state, "done");
    await call("update_song", { bpm: 140 });
  });

  await test("imports the MIDI it exported", async () => {
    await rejects("import_midi", { path: file("song.mid") }, /unsaved changes/);
    await call("import_midi", { path: file("song.mid"), discard_changes: true });
    const song = await call("get_song");
    assert.ok(song.patterns.length > 0);
    assert.ok(song.patterns.some((pattern) => pattern.note_count > 0), "no notes were imported");
  });

  await test("reports a corrupt file instead of hanging", async () => {
    writeFileSync(file("bad.ceol"), "not a song");
    await rejects("open_song", { path: file("bad.ceol"), discard_changes: true }, /Failed to load/);
  });

  await test("quits, respecting unsaved changes", async () => {
    await rejects("quit_app", {}, /unsaved changes/);
    await call("quit_app", { discard_changes: true });
    await new Promise((done) => setTimeout(done, 1500));
    assert.deepEqual(await call("app_status"), { running: false });
  });

  console.log(`\n${passed} tests passed`);
} finally {
  await client.close();
  await new Promise((done) => setTimeout(done, 500));
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch {
    // A leftover temp folder isn't worth failing over.
  }
}
