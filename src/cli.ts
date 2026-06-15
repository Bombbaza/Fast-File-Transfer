#!/usr/bin/env node
// Command-line interface:
//   fft serve                          start the direct transfer server
//   fft send <file> --to <url>         upload a file directly
//   fft recv <id> --from <url>         download a file directly
//   fft federation send <file> ...     send via relay gateway to a specific agent
//   fft federation recv ...            list incoming, accept, and download from gateway

import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { upload, download } from "./client.js";
import {
  registerAgent,
  sendToAgent,
  listIncoming,
  acceptTransfer,
  declineTransfer,
  downloadTransfer,
} from "./federation/index.js";

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
  fft serve                                   Start the direct transfer server
  fft send <file> --to <url>                  Upload a file; prints the file id
  fft recv <id> --from <url>                  Download a file by id (verifies sha256)

  fft federation register                     Register this agent on the gateway
  fft federation send <file> --to <agentId>   Send a file to another agent via gateway
  fft federation recv                         List incoming transfers (metadata only)
  fft federation accept <transferId>          Accept a pending transfer (consent-gate)
  fft federation decline <transferId>         Decline a pending transfer
  fft federation download <transferId>        Download an accepted transfer

Options:
  --to <url|agentId>  Server URL (send/recv) or recipient agentId (federation send)
  --from <url>        Server base URL for recv
  --gateway <url>     Relay gateway base URL (or env FFT_GATEWAY)
  --agent <id>        Your agent id (or env FFT_AGENT_ID)
  --token <tok>       Bearer token (or env FFT_TOKEN)
  --name <name>       Override the filename for send
  --chunk <n>         Chunk size in bytes for send
  --out <path>        Output path for recv/download (default: stored filename)
  -h, --help          Show this help

Server env vars: see .env.example (FFT_TOKEN, FFT_PORT, FFT_STORAGE_DIR, ...).
Federation env vars: FFT_GATEWAY, FFT_AGENT_ID, FFT_TOKEN.
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

  // ---- federation subcommands -----------------------------------------------

  if (cmd === "federation") {
    const sub = pos[1];
    const gateway = str(flags.gateway) ?? process.env.FFT_GATEWAY;
    const agentId = str(flags.agent) ?? process.env.FFT_AGENT_ID;
    const token = str(flags.token) ?? process.env.FFT_TOKEN;

    if (!sub || sub === "help") {
      process.stdout.write(USAGE);
      return;
    }

    if (!gateway) fail("federation: provide --gateway <url> or set FFT_GATEWAY");
    if (!agentId) fail("federation: provide --agent <id> or set FFT_AGENT_ID");

    const fedOpts = { gateway: gateway!, agentId: agentId!, token };

    if (sub === "register") {
      const res = await registerAgent(fedOpts);
      process.stderr.write(`registered: ${res.agentId}  at=${new Date(res.registeredAt).toISOString()}\n`);
      return;
    }

    if (sub === "send") {
      const file = pos[2];
      if (!file) fail("federation send: missing <file>");
      const toAgent = str(flags.to);
      if (!toAgent) fail("federation send: provide --to <agentId>");
      const res = await sendToAgent({
        ...fedOpts,
        file: file!,
        toAgentId: toAgent!,
        name: str(flags.name),
        chunkSize: num(flags.chunk),
        onProgress: progress("send"),
      });
      process.stdout.write(`${res.transferId}\n`);
      process.stderr.write(`done: transferId=${res.transferId}  sha256=${res.sha256}\n`);
      return;
    }

    if (sub === "recv") {
      const list = await listIncoming({ ...fedOpts, status: "pending" });
      if (list.length === 0) {
        process.stderr.write("no pending transfers\n");
        return;
      }
      for (const t of list) {
        process.stdout.write(`${t.transferId}\t${t.fromAgentId}\t${t.name}\t${fmtBytes(t.size)}\t${t.status}\n`);
      }
      return;
    }

    if (sub === "accept") {
      const transferId = pos[2];
      if (!transferId) fail("federation accept: missing <transferId>");
      const res = await acceptTransfer({ ...fedOpts, transferId: transferId! });
      process.stderr.write(`accepted: ${res.transferId}\n`);
      return;
    }

    if (sub === "decline") {
      const transferId = pos[2];
      if (!transferId) fail("federation decline: missing <transferId>");
      const res = await declineTransfer({ ...fedOpts, transferId: transferId! });
      process.stderr.write(`declined: ${res.transferId}\n`);
      return;
    }

    if (sub === "download") {
      const transferId = pos[2];
      if (!transferId) fail("federation download: missing <transferId>");
      const meta = await downloadTransfer({
        ...fedOpts,
        transferId: transferId!,
        dest: str(flags.out),
        onProgress: progress("recv"),
      });
      process.stderr.write(`saved: ${meta.name} (${fmtBytes(meta.size)})  sha256=${meta.sha256}\n`);
      return;
    }

    fail(`unknown federation subcommand: ${sub}`);
    return;
  }

  fail(`unknown command: ${cmd}`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
