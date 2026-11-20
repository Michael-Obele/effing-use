import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";

export type StateData = {
  notes: string[];
  lastActions: string[];
};

const stateCache = new Map<string, StateData>();

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
}

function statePath(config: Config, sessionId: string): string {
  return join(config.outputDir, "state", `${sanitizeSegment(sessionId)}.md`);
}

function getState(sessionId: string): StateData {
  let s = stateCache.get(sessionId);
  if (!s) {
    s = { notes: [], lastActions: [] };
    stateCache.set(sessionId, s);
  }
  return s;
}

export async function appendNote(
  config: Config,
  sessionId: string,
  note: string,
): Promise<void> {
  const s = getState(sessionId);
  const line = note.slice(0, 300);
  s.notes.push(line);
  const max = config.stateMaxLines ?? 40;
  while (s.notes.length > max) s.notes.shift();
  await persist(config, sessionId);
}

export async function appendAction(
  config: Config,
  sessionId: string,
  entry: string,
): Promise<void> {
  const s = getState(sessionId);
  s.lastActions.push(entry.slice(0, 200));
  while (s.lastActions.length > 10) s.lastActions.shift();
  await persist(config, sessionId);
}

async function persist(config: Config, sessionId: string): Promise<void> {
  const s = getState(sessionId);
  const path = statePath(config, sessionId);
  await mkdir(join(config.outputDir, "state"), { recursive: true });
  const content = [
    `# state:${sessionId}`,
    `## notes`,
    ...s.notes.map((n) => `- ${n}`),
    `## lastActions`,
    ...s.lastActions.map((a) => `- ${a}`),
  ].join("\n");
  await writeFile(path, content, "utf-8").catch(() => undefined);
}

export async function readState(
  config: Config,
  sessionId: string,
): Promise<{ notes: string; lastActions: string[]; path: string }> {
  const s = getState(sessionId);
  // Try to load from disk if cache empty
  if (s.notes.length === 0 && s.lastActions.length === 0) {
    try {
      const raw = await readFile(statePath(config, sessionId), "utf-8");
      const lines = raw.split("\n");
      let section: "notes" | "actions" | null = null;
      for (const l of lines) {
        if (l.startsWith("## notes")) section = "notes";
        else if (l.startsWith("## lastActions")) section = "actions";
        else if (l.startsWith("- ") && section === "notes")
          s.notes.push(l.slice(2));
        else if (l.startsWith("- ") && section === "actions")
          s.lastActions.push(l.slice(2));
      }
    } catch {
      /* no file yet */
    }
  }
  const notes = s.notes.join("\n").slice(0, 1500);
  return {
    notes,
    lastActions: [...s.lastActions],
    path: statePath(config, sessionId),
  };
}

export function clearState(sessionId: string): void {
  stateCache.delete(sessionId);
}
