// Measures and masters rendered WAVs. An AI tool can't listen to a song, so the
// measurements tell it whether a render came out silent, clipped, or too quiet
// for where it's going, and mastering brings it to a platform's loudness.
//
// Loudness follows ITU-R BS.1770-4 (integrated LUFS with gating), and true peak
// is measured with 4x oversampling, as streaming platforms do.

import { readFileSync, writeFileSync } from "node:fs";

export interface WavStats {
  duration_seconds: number;
  peak: number;
  rms: number;
  /** Integrated loudness in LUFS, or null for audio shorter than 0.4 s or silent. */
  loudness_lufs: number | null;
  /** Highest peak between samples too, in dBFS. */
  true_peak_db: number;
  silent: boolean;
  clipped: boolean;
}

interface Pcm {
  sampleRate: number;
  channels: Float64Array[];
}

/** Reads 16-bit PCM WAV data, or returns undefined for anything else. */
function readWav(path: string): Pcm | undefined {
  const file = readFileSync(path);
  if (file.length < 44 || file.toString("latin1", 0, 4) !== "RIFF" || file.toString("latin1", 8, 12) !== "WAVE") {
    return undefined;
  }

  let channelCount = 2;
  let sampleRate = 44100;
  let bits = 16;
  let offset = 12;

  while (offset + 8 <= file.length) {
    const chunk = file.toString("latin1", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (chunk === "fmt ") {
      channelCount = file.readUInt16LE(start + 2);
      sampleRate = file.readUInt32LE(start + 4);
      bits = file.readUInt16LE(start + 14);
    } else if (chunk === "data") {
      if (bits !== 16 || channelCount < 1) {
        return undefined;
      }
      const end = Math.min(start + size, file.length);
      const frames = Math.floor((end - start) / 2 / channelCount);
      const channels = Array.from({ length: channelCount }, () => new Float64Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channelCount; c++) {
          channels[c][i] = file.readInt16LE(start + (i * channelCount + c) * 2) / 32768;
        }
      }
      return { sampleRate, channels };
    }
    offset = start + size + (size % 2);
  }
  return undefined;
}

function writeWav(path: string, pcm: Pcm): void {
  const channelCount = pcm.channels.length;
  const frames = pcm.channels[0].length;
  const dataSize = frames * channelCount * 2;
  const file = Buffer.alloc(44 + dataSize);

  file.write("RIFF", 0, "latin1");
  file.writeUInt32LE(36 + dataSize, 4);
  file.write("WAVE", 8, "latin1");
  file.write("fmt ", 12, "latin1");
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(channelCount, 22);
  file.writeUInt32LE(pcm.sampleRate, 24);
  file.writeUInt32LE(pcm.sampleRate * channelCount * 2, 28);
  file.writeUInt16LE(channelCount * 2, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36, "latin1");
  file.writeUInt32LE(dataSize, 40);

  // Triangular dither, from a fixed seed so the same input masters the same way.
  // Digital silence stays silent.
  let seed = 0x2545f491;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const sample = pcm.channels[c][i];
      const value = sample === 0 ? 0 : Math.round(sample * 32768 + random() - random());
      file.writeInt16LE(Math.max(-32768, Math.min(32767, value)), offset);
      offset += 2;
    }
  }
  writeFileSync(path, file);
}

function toDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-10));
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function biquad(input: Float64Array, b: number[], a: number[]): Float64Array {
  const output = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    output[i] = y;
  }
  return output;
}

/** BS.1770 K-weighting, designed for any sample rate (the same way libebur128 does). */
function kWeight(input: Float64Array, rate: number): Float64Array {
  let k = Math.tan((Math.PI * 1681.974450955533) / rate);
  const vh = Math.pow(10, 3.999843853973347 / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let q = 0.7071752369554196;
  let a0 = 1 + k / q + k * k;
  const shelf = biquad(
    input,
    [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
    [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  );

  k = Math.tan((Math.PI * 38.13547087602444) / rate);
  q = 0.5003270373238773;
  a0 = 1 + k / q + k * k;
  return biquad(shelf, [1, -2, 1], [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]);
}

/** Integrated loudness in LUFS, with BS.1770's absolute and relative gates. */
export function integratedLoudness(pcm: Pcm): number | null {
  const block = Math.round(0.4 * pcm.sampleRate);
  const step = Math.round(0.1 * pcm.sampleRate);
  const frames = pcm.channels[0].length;
  if (frames < block) {
    return null;
  }

  const squared = pcm.channels.map((channel) => {
    const weighted = kWeight(channel, pcm.sampleRate);
    for (let i = 0; i < weighted.length; i++) {
      weighted[i] *= weighted[i];
    }
    return weighted;
  });

  const powers: number[] = [];
  for (let start = 0; start + block <= frames; start += step) {
    let power = 0;
    for (const channel of squared) {
      let sum = 0;
      for (let i = start; i < start + block; i++) {
        sum += channel[i];
      }
      power += sum / block;
    }
    powers.push(power);
  }

  const loudness = (power: number): number => -0.691 + 10 * Math.log10(power);
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

  const audible = powers.filter((power) => power > 0 && loudness(power) > -70);
  if (audible.length === 0) {
    return null;
  }
  const relativeGate = loudness(mean(audible)) - 10;
  const gated = audible.filter((power) => loudness(power) > relativeGate);
  return loudness(mean(gated));
}

// Windowed-sinc taps that interpolate a quarter, a half and three quarters of
// the way between two samples, for 4x oversampled true peak.
const HALF_TAPS = 8;
const PHASES = [0.25, 0.5, 0.75].map((fraction) => {
  const taps: number[] = [];
  for (let k = -HALF_TAPS + 1; k <= HALF_TAPS; k++) {
    const t = k - fraction;
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
    const window = 0.5 + 0.5 * Math.cos((Math.PI * t) / HALF_TAPS);
    taps.push(sinc * window);
  }
  return taps;
});

/** The highest true peak from each sample to the next, across all channels. */
function peakEnvelope(pcm: Pcm): Float64Array {
  const frames = pcm.channels[0].length;
  const envelope = new Float64Array(frames);
  for (const channel of pcm.channels) {
    for (let n = 0; n < frames; n++) {
      let peak = Math.abs(channel[n]);
      for (const taps of PHASES) {
        let value = 0;
        for (let k = 0; k < taps.length; k++) {
          const index = n + k - HALF_TAPS + 1;
          if (index >= 0 && index < frames) {
            value += taps[k] * channel[index];
          }
        }
        peak = Math.max(peak, Math.abs(value));
      }
      envelope[n] = Math.max(envelope[n], peak);
    }
  }
  return envelope;
}

export function analyzeWav(path: string): WavStats | undefined {
  const pcm = readWav(path);
  if (!pcm) {
    return undefined;
  }
  return measure(pcm);
}

function measure(pcm: Pcm): WavStats {
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (const channel of pcm.channels) {
    for (const sample of channel) {
      peak = Math.max(peak, Math.abs(sample));
      sum += sample * sample;
      count++;
    }
  }
  const loudness = integratedLoudness(pcm);
  const truePeak = peakEnvelope(pcm).reduce((max, value) => Math.max(max, value), 0);
  return {
    duration_seconds: round(pcm.channels[0].length / pcm.sampleRate, 2),
    peak: round(peak, 3),
    rms: round(Math.sqrt(sum / Math.max(count, 1)), 3),
    loudness_lufs: loudness === null ? null : round(loudness, 1),
    true_peak_db: round(toDb(truePeak), 1),
    silent: peak < 0.001,
    clipped: peak >= 0.999,
  };
}

export interface MasterOptions {
  targetLufs: number;
  truePeakDb: number;
  maxLimitingDb: number;
}

export interface MasterResult {
  gain_db: number;
  limiting_db: number;
  reached_target: boolean;
  before: WavStats;
  after: WavStats;
}

/**
 * Brings a WAV to a target loudness: one gain for the whole file, plus a
 * look-ahead limiter that keeps the true peak under the ceiling. If reaching the
 * target would take more limiting than allowed, it stops short instead of
 * squashing the music, and says so.
 */
export function masterWav(inputPath: string, outputPath: string, options: MasterOptions): MasterResult {
  const pcm = readWav(inputPath);
  if (!pcm) {
    throw new Error(`Not a 16-bit PCM WAV file: ${inputPath}`);
  }
  const before = measure(pcm);
  if (before.loudness_lufs === null || before.silent) {
    throw new Error("The file is silent or shorter than 0.4 seconds, so its loudness can't be measured.");
  }

  const rate = pcm.sampleRate;
  const frames = pcm.channels[0].length;
  const envelope = peakEnvelope(pcm);
  const ceiling = Math.pow(10, options.truePeakDb / 20);
  const lookahead = Math.max(1, Math.round(0.005 * rate));
  const release = 1 - Math.exp(-1 / (0.08 * rate));

  // The gain each sample can take, as a gain envelope that never lets a peak past
  // the ceiling: a running minimum over the look-ahead, a smooth release, then a
  // moving average as long as the look-ahead, which still stays under every
  // sample's limit.
  const limiterGain = (gain: number): Float64Array => {
    const needed = new Float64Array(frames);
    for (let n = 0; n < frames; n++) {
      const peak = envelope[n] * gain;
      needed[n] = peak > ceiling ? ceiling / peak : 1;
    }

    const held = new Float64Array(frames);
    const window: number[] = [];
    let head = 0;
    for (let n = frames - 1; n >= 0; n--) {
      while (window.length > head && needed[window[window.length - 1]] >= needed[n]) {
        window.pop();
      }
      window.push(n);
      if (window[head] > n + lookahead - 1) {
        head++;
      }
      held[n] = needed[window[head]];
    }

    let level = 1;
    for (let n = 0; n < frames; n++) {
      level = held[n] <= level ? held[n] : level + (held[n] - level) * release;
      held[n] = level;
    }

    const smooth = new Float64Array(frames);
    // Before the start, the average counts the first value, which already covers
    // the first look-ahead's peaks.
    let sum = lookahead * held[0];
    for (let n = 0; n < frames; n++) {
      sum += held[n] - (n >= lookahead ? held[n - lookahead] : held[0]);
      smooth[n] = sum / lookahead;
    }
    return smooth;
  };

  const render = (gain: number): { output: Pcm; limiting: number } => {
    const shape = limiterGain(gain);
    let lowest = 1;
    for (const value of shape) {
      lowest = Math.min(lowest, value);
    }
    const channels = pcm.channels.map((channel) => channel.map((sample, n) => sample * gain * shape[n]));
    return { output: { sampleRate: rate, channels }, limiting: -toDb(lowest) };
  };

  // Loudness and limiting both rise with gain, so look for the highest gain that
  // stays within the target and the limiting allowed, between a gain known to fit
  // and one known not to.
  let fits: { gainDb: number; output: Pcm; limiting: number } | undefined;
  let tooLoud: number | undefined;
  let gainDb = options.targetLufs - before.loudness_lufs;
  let previous: { gainDb: number; loudness: number } | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const attemptResult = render(Math.pow(10, gainDb / 20));
    const loudness = integratedLoudness(attemptResult.output) ?? options.targetLufs;
    const overLimit = attemptResult.limiting - options.maxLimitingDb;
    if (overLimit <= 0.05 && loudness <= options.targetLufs + 0.05) {
      fits = { gainDb, ...attemptResult };
      if (options.targetLufs - loudness < 0.05) {
        break;
      }
      // Under limiting, a dB of gain adds less than a dB of loudness.
      const slope = previous && gainDb !== previous.gainDb ? (loudness - previous.loudness) / (gainDb - previous.gainDb) : 1;
      previous = { gainDb, loudness };
      gainDb += (options.targetLufs - loudness) / Math.min(1, Math.max(0.2, slope));
    } else {
      tooLoud = gainDb;
      gainDb -= overLimit > 0.05 ? Math.max(overLimit, 0.1) : loudness - options.targetLufs;
    }
    if (fits && tooLoud !== undefined) {
      if (tooLoud - fits.gainDb < 0.05) {
        break;
      }
      if (gainDb <= fits.gainDb || gainDb >= tooLoud) {
        gainDb = (fits.gainDb + tooLoud) / 2;
      }
    }
  }
  if (!fits) {
    // A gain that needs no limiting and can't pass the target always fits.
    const peak = envelope.reduce((max, value) => Math.max(max, value), 0);
    gainDb = Math.min(options.targetLufs - before.loudness_lufs, toDb(ceiling / peak));
    fits = { gainDb, ...render(Math.pow(10, gainDb / 20)) };
  }
  const result = fits;
  gainDb = fits.gainDb;

  // The limiter works on the input's true peaks, and its gain changes can add a
  // little overshoot of their own, so make sure of the ceiling at the end.
  const finalPeak = peakEnvelope(result.output).reduce((max, value) => Math.max(max, value), 0);
  if (finalPeak > ceiling) {
    const trim = (ceiling / finalPeak) * 0.999;
    for (const channel of result.output.channels) {
      for (let n = 0; n < channel.length; n++) {
        channel[n] *= trim;
      }
    }
  }

  writeWav(outputPath, result.output);
  const after = analyzeWav(outputPath) as WavStats;
  return {
    gain_db: round(gainDb, 1),
    limiting_db: round(result.limiting, 1),
    reached_target: after.loudness_lufs !== null && after.loudness_lufs >= options.targetLufs - 0.3,
    before,
    after,
  };
}
