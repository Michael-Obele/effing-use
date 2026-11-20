// Mobile error shape mirrors the browser server's EngineError envelope so an
// agent that has learned one product reads the other without a new vocabulary.
export class MobileError extends Error {
  code: string;
  hint: string;
  data?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    hint: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.data = data;
  }
}

/**
 * Turn any throw into the standard envelope. `recent` is filled by the caller
 * (the journal owns what happened before the failure, the tool does not).
 */
export function toEnvelope(
  e: unknown,
  opts: { journal?: string; hint?: string } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = { ok: false };
  if (opts.journal) base.journal = opts.journal;
  if (e instanceof MobileError) {
    return {
      ...base,
      code: e.code,
      message: e.message,
      hint: e.hint,
      ...(e.data ?? {}),
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    ...base,
    code: "E_MOBILE",
    // adb and CDP errors carry multi-line stacks; the agent needs the first line.
    message: message.split("\n")[0].slice(0, 400),
    hint:
      opts.hint ??
      "Retry the call, or run observe kind=state to check the session.",
  };
}
