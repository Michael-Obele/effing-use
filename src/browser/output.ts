import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";

export async function saveText(
  config: Config,
  filename: string,
  text: string,
): Promise<string> {
  await mkdir(config.outputDir, { recursive: true });
  const path = join(config.outputDir, filename);
  await writeFile(path, text, "utf-8");
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
