// Finds and starts Bosca Ceoil Blue, and talks to the bridge running inside it.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 20_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;

const DOWNLOAD_URL = "https://yurisizov.itch.io/boscaceoil-blue";
const STATE_DIR = join(homedir(), ".bosca-ceoil-mcp");
const SESSION_FILE = join(STATE_DIR, "session.json");
const LOG_FILE = join(STATE_DIR, "app.log");

const BOOT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "boot.gd");

const EXECUTABLE_NAMES: Record<string, string[]> = {
  win32: ["boscaceoil-blue.exe"],
  darwin: ["boscaceoil-blue", "Bosca Ceoil Blue", "Bosca Ceoil The Blue Album"],
  linux: ["boscaceoil-blue.x86_64", "boscaceoil-blue"],
};

export interface AppOptions {
  appPath?: string;
  headless: boolean;
}

interface Session {
  port: number;
  token: string;
  pid: number;
  version: string;
  headless: boolean;
  error?: string;
}

/** A problem to report to the user as it is, rather than as a failed request. */
export class AppError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Looks for the executable in a folder and the folders below it. */
function findIn(folder: string, depth: number): string | undefined {
  if (!isDirectory(folder)) {
    return undefined;
  }

  for (const name of EXECUTABLE_NAMES[process.platform] ?? []) {
    const candidate = join(folder, name);
    if (isFile(candidate)) {
      return candidate;
    }
    const inBundle = join(folder, "Contents", "MacOS", name);
    if (isFile(inBundle)) {
      return inBundle;
    }
  }

  if (depth <= 0) {
    return undefined;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(folder);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (/bosca/i.test(entry)) {
      const found = findIn(join(folder, entry), depth - 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** A configured folder needn't have "bosca" in its name, unlike the ones we search on our own. */
function findAnyBelow(folder: string): string | undefined {
  if (!isDirectory(folder)) {
    return undefined;
  }
  for (const entry of readdirSync(folder)) {
    const found = findIn(join(folder, entry), 3);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function locateApp(configured?: string): string {
  if (configured) {
    const path = resolve(configured);
    if (isFile(path)) {
      return path;
    }
    const found = findIn(path, 3) ?? findAnyBelow(path);
    if (found) {
      return found;
    }
    throw new AppError(`Bosca Ceoil Blue wasn't found at the configured path: ${path}`);
  }

  const home = homedir();
  const searchRoots = [
    join(home, "Downloads"),
    join(home, "Desktop"),
    join(home, "Applications"),
    join(home, "Games"),
    "/Applications",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
    process.env.APPDATA && join(process.env.APPDATA, "itch", "apps"),
    process.env.PROGRAMFILES,
    join(home, ".config", "itch", "apps"),
  ];

  for (const root of searchRoots) {
    const found = root && findIn(root, 3);
    if (found) {
      return found;
    }
  }

  throw new AppError(
    `Bosca Ceoil Blue wasn't found. Download it from ${DOWNLOAD_URL}, then point this server at it ` +
      "with the BOSCA_CEOIL_PATH environment variable or the --app-path argument.",
  );
}

export class BoscaApp {
  private socket: Socket | undefined;
  private session: Session | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private launching: Promise<void> | undefined;
  private startedForRequest = false;

  constructor(private readonly options: AppOptions) {}

  private readSessionFile(): Session | undefined {
    try {
      return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Session;
    } catch {
      return undefined;
    }
  }

  private connect(session: Session): Promise<void> {
    return new Promise((done, fail) => {
      const socket = new Socket();
      socket.setEncoding("utf8");
      socket.once("error", fail);
      socket.connect(session.port, "127.0.0.1", () => {
        socket.off("error", fail);
        socket.on("error", () => this.handleDisconnect());
        socket.on("close", () => this.handleDisconnect());
        socket.on("data", (chunk: string) => this.handleData(chunk));
        this.socket = socket;
        this.session = session;
        done();
      });
    });
  }

  private handleDisconnect(): void {
    this.socket = undefined;
    this.session = undefined;
    this.buffer = "";
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new AppError("Bosca Ceoil Blue closed before responding."));
    }
    this.pending.clear();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let lineEnd: number;
    while ((lineEnd = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 1);

      const response = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string };
      const request = this.pending.get(response.id);
      if (!request) {
        continue;
      }
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) {
        request.resolve(response.result);
      } else {
        request.reject(new AppError(response.error ?? "Unknown error."));
      }
    }
  }

  /** Connects to an instance that is already running with the bridge. */
  async attach(): Promise<boolean> {
    if (this.socket) {
      return true;
    }
    const session = this.readSessionFile();
    if (!session || session.error) {
      return false;
    }
    try {
      await this.connect(session);
      return true;
    } catch {
      return false; // Left behind by an instance that didn't shut down cleanly.
    }
  }

  async launch(headless = this.options.headless): Promise<void> {
    if (await this.attach()) {
      return;
    }
    this.launching ??= this.startAndWait(headless).finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async startAndWait(headless: boolean): Promise<void> {
    const executable = locateApp(this.options.appPath);

    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    rmSync(SESSION_FILE, { force: true });

    const args = [
      ...(headless ? ["--headless"] : []),
      "--script",
      BOOT_SCRIPT.replaceAll("\\", "/"),
      "--",
      `--mcp-session=${SESSION_FILE.replaceAll("\\", "/")}`,
    ];

    // Detached, so that closing the AI tool doesn't take the user's song with it.
    const log = openSync(LOG_FILE, "w");
    const child = spawn(executable, args, {
      cwd: dirname(executable),
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);

    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    child.unref();

    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(SESSION_FILE)) {
        const session = this.readSessionFile();
        if (session?.error) {
          throw new AppError(`${session.error} See ${LOG_FILE}.`);
        }
        if (session) {
          await this.connect(session);
          return;
        }
      }
      if (exited) {
        throw new AppError(`Bosca Ceoil Blue exited while starting. See ${LOG_FILE}.`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new AppError(`Bosca Ceoil Blue didn't respond within ${LAUNCH_TIMEOUT_MS / 1000} seconds. See ${LOG_FILE}.`);
  }

  /** Sends a request to the app, starting the app if it isn't running. */
  async call<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (!(await this.attach())) {
      await this.launch();
      this.startedForRequest = true;
    }
    const socket = this.socket;
    const session = this.session;
    if (!socket || !session) {
      throw new AppError("Couldn't connect to Bosca Ceoil Blue.");
    }

    const id = this.nextId++;
    return new Promise<T>((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new AppError("Bosca Ceoil Blue didn't respond in time. A dialog may be open in the app, waiting for an answer."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: done as (value: unknown) => void, reject: fail, timer });
      socket.write(JSON.stringify({ id, token: session.token, method, params }) + "\n");
    });
  }

  /** True once if the last request had to start the app, meaning any earlier song is gone. */
  takeStartedForRequest(): boolean {
    const started = this.startedForRequest;
    this.startedForRequest = false;
    return started;
  }

  disconnect(): void {
    this.socket?.destroy();
  }
}
