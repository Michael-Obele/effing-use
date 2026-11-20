import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MobileConfig } from "./config.js";

/**
 * Binary payloads (screenshots, full trees, HAR) go to a file and only the path
 * is returned: base64 inside a tool result is the expensive mistake.
 */
export async function writeOut(
  cfg: MobileConfig,
  filename: string,
  data: string | Buffer,
): Promise<string> {
  const dir = join(cfg.outputDir, "artifacts");
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, data);
  return path;
}

export function cap(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text:
      text.slice(0, maxChars) +
      `\n…[truncated ${text.length - maxChars} chars, see file]`,
    truncated: true,
  };
}

export function stamp(prefix: string, ext: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
}
