// The MCP tools. Nearly all of them forward to the bridge inside the app, which
// does the validation that depends on the song and on the app's data.

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError, type BoscaApp } from "./app.js";
import { analyzeWav } from "./wav.js";

const EXPORT_POLL_MS = 500;
const DEFAULT_EXPORT_WAIT_SECONDS = 40;

const SCALES =
  "normal (all notes), major, minor (melodic, with a raised 6th and 7th; for natural minor, use the relative major's key with scale major), blues, harmonic minor, pentatonic major, pentatonic minor, pentatonic blues, " +
  "pentatonic neutral, romanian folk, spanish gypsy, arabic magam, chinese, hungarian, chord: major, chord: minor, " +
  "chord: 5th, chord: dom 7th, chord: major 7th, chord: minor 7th, chord: minor major 7th, chord: sus4, chord: sus2";

const noteSchema = z.object({
  note: z
    .union([z.string(), z.number().int()])
    .describe('Pitch name or number, where C4 is 60 ("C4", "F#5", "Bb3", 60). For a drumkit, the item name or its value from get_drumkit.'),
  pos: z.number().int().describe("Step in the pattern where the note starts, from 0."),
  len: z.number().int().optional().describe("Length in steps, 1 by default. May run past the end of the pattern."),
});

const instrumentSchema = {
  voice: z.union([z.string(), z.number().int()]).describe('Voice from list_voices: "MIDI/Grand Piano", a unique part of a name, or its index.'),
  volume: z.number().int().min(0).max(256).optional().describe("0-256, 256 by default."),
  cutoff: z.number().int().min(0).max(128).optional().describe("Low-pass filter cutoff, 0-128. 128 (the default) means no filtering."),
  resonance: z.number().int().min(0).max(9).optional().describe("Low-pass filter resonance, 0-9."),
};

const keyField = z.union([z.string(), z.number().int()]).optional().describe('Key, like "C", "F#" or "Bb". Ignored for drumkits.');
const scaleField = z
  .union([z.string(), z.number().int()])
  .optional()
  .describe(`Scale. Notes must fit it. Ignored for drumkits. One of: ${SCALES}.`);

const patternSchema = {
  instrument: z.number().int().optional().describe("Index of the song's instrument, 0 by default."),
  key: keyField,
  scale: scaleField,
  notes: z.array(noteSchema).optional().describe("Up to 128 notes."),
};

const barsField = z
  .array(z.array(z.number().int().nullable()))
  .describe("One entry per bar, each a list of up to 8 channels holding a pattern index or null. [[0, 2], [1, 2, null, 3]] is two bars.");

const songSettings = {
  bpm: z.number().int().min(10).max(450).optional().describe("Beats per minute, 120 by default."),
  pattern_size: z.number().int().min(1).max(32).optional().describe("Steps in every pattern, 16 by default. Each step is a quarter of a beat."),
  bar_size: z.number().int().min(1).max(32).optional().describe("Steps between the grid's bar lines, 4 by default. Purely visual."),
  swing: z.number().int().min(-10).max(10).optional().describe("Swing, from -10 to 10. 0 is straight."),
  effect: z.union([z.string(), z.number().int()]).optional().describe("Global effect: delay, chorus, reverb, distortion, low boost, compressor or high pass."),
  effect_power: z.number().int().min(0).max(130).optional().describe("Effect strength. 5 or lower turns it off."),
};

const discardField = z.boolean().optional().describe("Must be true to replace a song with unsaved changes.");
const overwriteField = z.boolean().optional().describe("Must be true to replace an existing file.");

// Every tool states all four hints. Edits aren't marked idempotent, since repeating one,
// like add_pattern or undo, usually changes the song again.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function withAbsolutePath<T extends { path?: string }>(args: T): T {
  return args.path ? { ...args, path: absolutePath(args.path) } : args;
}

export function registerTools(server: McpServer, app: BoscaApp): void {
  const respond = (result: unknown): ToolResult => {
    const notice = app.takeStartedForRequest()
      ? "\nNote: Bosca Ceoil Blue wasn't running, so it was started, with a new empty song. Any song from before is no longer open."
      : "";
    return { content: [{ type: "text", text: JSON.stringify(result) + notice }] };
  };

  const fail = (error: unknown): ToolResult => {
    const message = error instanceof AppError || error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  };

  const run = async (work: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return respond(await work());
    } catch (error) {
      return fail(error);
    }
  };

  /** Registers a tool that sends its arguments straight to a bridge method. */
  const forward = (name: string, description: string, inputSchema: z.ZodRawShape, annotations: object, method = name): void => {
    server.registerTool(name, { description, inputSchema, annotations }, async (args: Record<string, unknown>) =>
      run(() => app.call(method, withAbsolutePath(args))),
    );
  };

  // App.

  server.registerTool(
    "app_status",
    {
      description: "Reports whether Bosca Ceoil Blue is running, plus its version, the current song's summary, and playback and export state. Doesn't start the app.",
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        if (!(await app.attach())) {
          return { running: false };
        }
        return { running: true, ...(await app.call<object>("status")) };
      }),
  );

  server.registerTool(
    "launch_app",
    {
      description:
        "Starts Bosca Ceoil Blue. Other tools do this on demand, so it's only needed to choose the mode or to open the window before working.",
      inputSchema: {
        headless: z.boolean().optional().describe("Run without a window or sound. Exports still work. The song is lost when the AI tool disconnects unless saved."),
      },
      annotations: EDIT,
    },
    async ({ headless }) =>
      run(async () => {
        const wasRunning = await app.attach();
        if (!wasRunning) {
          await app.launch(headless);
        }
        return { already_running: wasRunning, ...(await app.call<object>("status")) };
      }),
  );

  forward("quit_app", "Closes Bosca Ceoil Blue.", { discard_changes: discardField }, DESTRUCTIVE, "quit");

  server.registerTool(
    "screenshot_app",
    {
      description: "Captures the app's window as an image, to check what the user is seeing. Not available without a window.",
      annotations: READ_ONLY,
    },
    async () => {
      const path = join(tmpdir(), `bosca-ceoil-${randomUUID()}.png`);
      try {
        await app.call("screenshot", { path: path.replaceAll("\\", "/") });
        const image = readFileSync(path).toString("base64");
        return { content: [{ type: "image" as const, data: image, mimeType: "image/png" }] };
      } catch (error) {
        return fail(error);
      } finally {
        rmSync(path, { force: true });
      }
    },
  );

  forward(
    "focus",
    "Shows something in the app's window: selects a pattern for the note grid, selects an instrument, or switches views.",
    {
      pattern: z.number().int().optional(),
      instrument: z.number().int().optional(),
      view: z.enum(["file", "arrangement", "instrument", "advanced"]).optional(),
    },
    EDIT,
  );

  // Songs.

  forward(
    "create_song",
    "Replaces the open song with a new one, optionally built in one go from settings, instruments, patterns and an arrangement. This is the quickest way to write a song. Without instruments and patterns, you get the app's default: one Grand Piano, and one empty pattern on bar 0.",
    {
      ...songSettings,
      instruments: z.array(z.object(instrumentSchema)).max(16).optional().describe("Up to 16. Patterns refer to them by position in this list."),
      patterns: z.array(z.object(patternSchema)).optional().describe("Bars refer to them by position in this list."),
      bars: barsField.optional(),
      loop_start: z.number().int().optional().describe("First bar of the loop, 0 by default."),
      loop_end: z.number().int().optional().describe("Bar after the last bar of the loop. By default, the end of the song."),
      discard_changes: discardField,
    },
    DESTRUCTIVE,
  );

  forward(
    "open_song",
    "Opens a .ceol song file.",
    { path: z.string().describe("Path to the .ceol file."), discard_changes: discardField },
    DESTRUCTIVE,
  );

  forward(
    "import_midi",
    "Replaces the open song with one imported from a MIDI file. Bosca is a step sequencer, so complex timing may not survive.",
    {
      path: z.string().describe("Path to the .mid file."),
      pattern_size: z.number().int().min(0).max(32).optional().describe("Steps per pattern. 0 or absent detects it from the file."),
      discard_changes: discardField,
    },
    DESTRUCTIVE,
  );

  forward(
    "save_song",
    "Saves the song as a .ceol file. Songs aren't saved automatically.",
    {
      path: z.string().optional().describe("Where to save it. Can be left out if the song already has a file."),
      overwrite: overwriteField,
    },
    DESTRUCTIVE,
  );

  server.registerTool(
    "export_song",
    {
      description:
        "Exports the song as audio or music data: wav (rendered audio), mid (MIDI), mml (SiON MML) or xm (FastTracker). A WAV renders at about playback speed or slower, so a long one returns state \"rendering\"; follow it up with export_status. A finished WAV reports its duration, peak and RMS, to help catch silent or clipped results.",
      inputSchema: {
        format: z.enum(["wav", "mid", "mml", "xm"]),
        path: z.string().describe("Where to write it. The extension must match the format."),
        from_bar: z.number().int().optional().describe("First bar to export, 0 by default."),
        to_bar: z.number().int().optional().describe("Bar after the last one to export. By default, the end of the song."),
        overwrite: overwriteField,
        wait_seconds: z.number().min(0).max(300).optional().describe(`How long to wait for a WAV before returning, ${DEFAULT_EXPORT_WAIT_SECONDS} by default.`),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ wait_seconds, ...args }) =>
      run(async () => {
        let job = await app.call<ExportJob>("export_song", withAbsolutePath(args));
        const deadline = Date.now() + (wait_seconds ?? DEFAULT_EXPORT_WAIT_SECONDS) * 1000;
        while (job.state === "rendering" && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, EXPORT_POLL_MS));
          job = await app.call<ExportJob>("export_status");
        }
        return describeExport(job);
      }),
  );

  server.registerTool(
    "export_status",
    {
      description: "Reports how the current or most recent WAV export is going. The song can't be edited while it renders.",
      annotations: READ_ONLY,
    },
    async () => run(async () => describeExport(await app.call<ExportJob>("export_status"))),
  );

  forward(
    "get_song",
    "Returns the whole song: settings, instruments, patterns with their notes, and the arrangement. Notes are in the same form the editing tools take.",
    { include_notes: z.boolean().optional().describe("Set to false for just a summary of each pattern.") },
    READ_ONLY,
  );

  forward("update_song", "Changes song settings. Takes effect immediately, even during playback.", songSettings, EDIT);

  // Instruments.

  forward(
    "list_voices",
    "Lists the app's voices (over 300), to pick from when adding an instrument. Filter them, since the full list is long.",
    {
      query: z.string().optional().describe('Text to look for in the name or category, like "bass" or "piano".'),
      category: z.string().optional().describe("Exact category, like MIDI, CHIPTUNE, LEAD or DRUMKIT."),
    },
    READ_ONLY,
  );

  forward(
    "get_drumkit",
    "Lists the items of a drumkit voice. In a drumkit pattern, each 'note' is one of these items instead of a pitch.",
    { voice: z.union([z.string(), z.number().int()]).describe('Drumkit voice, like "DRUMKIT/Simple Drumkit".') },
    READ_ONLY,
  );

  forward("add_instrument", "Adds an instrument to the song. A song can have 16.", instrumentSchema, EDIT);

  forward(
    "update_instrument",
    "Changes an instrument's voice or settings. Every pattern using it changes too. Switching a pattern's instrument to a drumkit drops notes that have no matching item.",
    { instrument: z.number().int().describe("Index of the instrument."), ...instrumentSchema, voice: instrumentSchema.voice.optional() },
    EDIT,
  );

  forward(
    "remove_instrument",
    "Removes an instrument. Later instruments move down one index, and patterns using it switch to instrument 0.",
    { instrument: z.number().int() },
    DESTRUCTIVE,
  );

  // Patterns.

  forward(
    "add_pattern",
    "Adds a pattern and returns its index. It won't play until the arrangement uses it. Notes are absolute pitches, so the key and scale don't move them; they must fit that key and scale.",
    patternSchema,
    EDIT,
  );

  forward(
    "update_pattern",
    "Edits a pattern's notes, key, scale, instrument or filter automation, as one undo step. Changing the key transposes its notes, like the app does. Changing the scale removes notes that don't fit it.",
    {
      pattern: z.number().int().describe("Index of the pattern."),
      ...patternSchema,
      notes_mode: z.enum(["replace", "add", "remove"]).optional().describe("How to use notes: replace all of them (the default), add to them, or remove these. For remove, only note and pos matter."),
      transpose_with_key: z.boolean().optional().describe("Set to false to relabel the key without moving the notes."),
      record_filter: z.boolean().optional().describe("Turns per-step volume and filter automation on or off for this pattern."),
      filter_steps: z
        .array(
          z.object({
            pos: z.number().int(),
            volume: z.number().int().min(0).max(256).optional(),
            cutoff: z.number().int().min(0).max(128).optional(),
            resonance: z.number().int().min(0).max(9).optional(),
          }),
        )
        .optional()
        .describe("Automation values per step. Only the first 16 steps are kept when the song is saved, a limit of the file format."),
    },
    EDIT,
  );

  forward("clone_pattern", "Copies a pattern to a new index, as a starting point for a variation.", { pattern: z.number().int() }, EDIT);

  forward(
    "remove_pattern",
    "Removes a pattern and clears it from the arrangement. Later patterns move down one index.",
    { pattern: z.number().int() },
    DESTRUCTIVE,
  );

  // Arrangement.

  forward(
    "edit_arrangement",
    "Places patterns on the timeline. Each bar plays up to 8 patterns at once, on separate channels. Writes whole bars starting at at_bar, leaving other bars alone. Unless a loop is given, the loop then covers the whole song.",
    {
      bars: barsField,
      at_bar: z.number().int().optional().describe("Bar to start writing at, 0 by default."),
      replace_all: z.boolean().optional().describe("Clears the rest of the timeline first."),
      loop_start: z.number().int().optional(),
      loop_end: z.number().int().optional().describe("Bar after the last bar of the loop."),
    },
    EDIT,
  );

  // Playback.

  forward(
    "play",
    "Plays the song through the user's speakers, looping until stopped. The AI tool can't hear it, so use this when the user wants to listen.",
    { from_bar: z.number().int().optional().describe("Bar to start from, which must be inside the loop.") },
    EDIT,
  );
  forward("pause", "Pauses playback, keeping the position.", {}, EDIT);
  forward("stop", "Stops playback and goes back to the start of the loop.", {}, EDIT);

  // History.

  forward("undo", "Undoes the last edit, made by the user or by a tool. The app keeps 40 steps. Opening or creating a song clears them.", {}, EDIT);
  forward("redo", "Redoes the last undone edit.", {}, EDIT);
}

interface ExportJob {
  state: string;
  path?: string;
  format?: string;
}

function describeExport(job: ExportJob): object {
  if (job.state === "done" && job.format === "wav" && job.path) {
    return { ...job, ...analyzeWav(job.path) };
  }
  return job;
}
