#!/usr/bin/env node
// Command-line interface: `fft serve`, `fft send <file>`, `fft recv <id>`.

import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { upload, download } from "./client.js";

interface Parsed {
  pos: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const isLong = a.startsWith("--");
    const isShort = !isLong && a.startsWith("-") && a.length > 1;
    if (isLong || isShort) {
      const key = a.slice(isLong ? 2 : 1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: string | boolean | undefined): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${i === 0 ? x : x.toFixed(1)}${u[i]}`;
}

function progress(label: string): (done: number, total: number) => void {
  let last = -1;
  return (done, total) => {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
    if (pct !== last) {
      last = pct;
      process.stderr.write(`\r${label}: ${pct}% (${fmtBytes(done)}/${fmtBytes(total)})    `);
    }
    if (done >= total) process.stderr.write("\n");
  };
}

const USAGE = `Fast File Transfer (fft)

Usage:
  fft serve                          Start the transfer server (config from env / .env)
  fft send <file> --to <url>         Upload a file; prints the file id on success
  fft recv <id> --from <url>         Download a file by id (verifies sha256)

Options:
  --to <url>      Server base URL for send (or env FFT_SERVER)
  --from <url>    Server base URL for recv (or env FFT_SERVER)
  --token <tok>   Bearer token (or env FFT_TOKEN)
  --name <name>   Override the filename for send
  --chunk <n>     Chunk size in bytes for send
  --out <path>    Output path for recv (default: stored filename)
  -h, --help      Show this help

Server env vars: see .env.example (FFT_TOKEN, FFT_PORT, FFT_STORAGE_DIR, ...).
`;

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos[0];

  if (!cmd || cmd === "help" || flags.help || flags.h) {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === "serve") {
    const cfg = loadConfig();
    await startServer({ config: cfg });
    process.stderr.write(`fft server listening on ${cfg.host}:${cfg.port} (storage: ${cfg.storageDir})\n`);
    if (cfg.token === "") {
      process.stderr.write("WARNING: FFT_TOKEN is empty — authentication is DISABLED. Do not expose this publicly.\n");
    }
    return; // keep the process alive
  }

  if (cmd === "send") {
    const file = pos[1];
    if (!file) fail("send: missing <file>");
    const server = str(flags.to) ?? process.env.FFT_SERVER;
    if (!server) fail("send: provide --to <url> or set FFT_SERVER");
    const token = str(flags.token) ?? process.env.FFT_TOKEN;
    const res = await upload({
      server, token, file,
      name: str(flags.name), chunkSize: num(flags.chunk),
      onProgress: progress("send"),
    });
    process.stdout.write(`${res.id}\n`);
    process.stderr.write(`done: ${res.name} (${fmtBytes(res.size)})  id=${res.id}  sha256=${res.sha256}\n`);
    return;
  }

  if (cmd === "recv") {
    const id = pos[1];
    if (!id) fail("recv: missing <id>");
    const server = str(flags.from) ?? process.env.FFT_SERVER;
    if (!server) fail("recv: provide --from <url> or set FFT_SERVER");
    const token = str(flags.token) ?? process.env.FFT_TOKEN;
    const meta = await download({ server, token, id, dest: str(flags.out), onProgress: progress("recv") });
    process.stderr.write(`saved: ${meta.name} (${fmtBytes(meta.size)})  sha256=${meta.sha256}\n`);
    return;
  }

  fail(`unknown command: ${cmd}`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
