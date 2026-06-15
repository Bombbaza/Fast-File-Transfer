import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

/** Stream a file from disk and return its lowercase-hex sha256. Constant memory. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on("data", (c) => hash.update(c));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return hash.digest("hex");
}

/** sha256 of an in-memory buffer (small bodies / per-chunk checks). */
export function sha256Buffer(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A URL-safe random hex id / secret. Default 16 bytes = 128 bits. */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Constant-time comparison for secrets/tokens (avoids timing leaks). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
