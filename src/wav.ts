// Measures a rendered WAV, so that an AI tool, which can't listen to it, can at
// least tell whether it came out silent or clipped.

import { readFileSync } from "node:fs";

export interface WavStats {
  duration_seconds: number;
  peak: number;
  rms: number;
  silent: boolean;
  clipped: boolean;
}

export function analyzeWav(path: string): WavStats | undefined {
  const file = readFileSync(path);
  if (file.length < 44 || file.toString("latin1", 0, 4) !== "RIFF" || file.toString("latin1", 8, 12) !== "WAVE") {
    return undefined;
  }

  let channels = 2;
  let sampleRate = 44100;
  let offset = 12;

  while (offset + 8 <= file.length) {
    const chunk = file.toString("latin1", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (chunk === "fmt ") {
      channels = file.readUInt16LE(start + 2);
      sampleRate = file.readUInt32LE(start + 4);
    } else if (chunk === "data") {
      const end = Math.min(start + size, file.length);
      let peak = 0;
      let sum = 0;
      let count = 0;
      for (let i = start; i + 2 <= end; i += 2) {
        const sample = file.readInt16LE(i) / 32768;
        peak = Math.max(peak, Math.abs(sample));
        sum += sample * sample;
        count++;
      }
      return {
        duration_seconds: Number((count / channels / sampleRate).toFixed(2)),
        peak: Number(peak.toFixed(3)),
        rms: Number(Math.sqrt(sum / Math.max(count, 1)).toFixed(3)),
        silent: peak < 0.001,
        clipped: peak >= 0.999,
      };
    }
    offset = start + size + (size % 2);
  }
  return undefined;
}
