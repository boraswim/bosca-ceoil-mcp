#!/usr/bin/env node
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoscaApp } from "./app.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `Compose music in Bosca Ceoil Blue, a step sequencer. Edits appear live in the app's window, and the user can undo them with Ctrl+Z.

How a song is built:
- A song has up to 16 instruments, each using a voice from list_voices.
- A pattern is one instrument's notes for one bar. All patterns have the same length, pattern_size (16 steps by default). A step is a quarter of a beat, so at 16 steps a pattern is 4 beats.
- The arrangement lists what plays in each bar. A bar plays up to 8 patterns at once, one per channel.
- A pattern makes no sound until the arrangement uses it. Bars use patterns by index, and one pattern can be reused in many bars.

Writing notes:
- Pitches use scientific names where C4 is 60 (middle C), and the range is C-1 to G7. The app's own octave labels read two higher, so C4 is in the octave it labels 6.
- A pattern's scale limits its notes. Use scale "normal" to allow anything, otherwise off-scale notes are rejected.
- The app's "minor" scale is melodic, with a raised 6th and 7th, so A minor has F# and G# rather than F and G. For natural A minor, use key C with scale major, which has the same notes.
- Drumkit patterns use item names from get_drumkit in place of pitches.

Good habits:
- Prefer create_song for a new piece, since it takes everything in one call.
- You can't hear the result. Check your work with get_song, and export_song to WAV reports whether it is silent or clipped. Ask the user to listen, using play.
- Songs aren't saved automatically, so call save_song when the work is worth keeping.`;

const { values } = parseArgs({
  options: {
    "app-path": { type: "string" },
    headless: { type: "boolean", default: false },
  },
});

const envHeadless = ["1", "true"].includes((process.env.BOSCA_CEOIL_HEADLESS ?? "").toLowerCase());

const app = new BoscaApp({
  appPath: values["app-path"] ?? process.env.BOSCA_CEOIL_PATH,
  headless: values.headless || envHeadless,
});

const server = new McpServer({ name: "bosca-ceoil", version: "0.1.0" }, { instructions: INSTRUCTIONS });
registerTools(server, app);

await server.connect(new StdioServerTransport());

process.stdin.once("close", () => {
  app.disconnect();
  process.exit(0);
});
