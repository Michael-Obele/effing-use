import { spawn } from "node:child_process";
import { MobileError } from "./errors.js";
import type { MobileConfig } from "./config.js";

export type Device = { serial: string; state: string; model: string };

/** Run adb and return raw stdout. Binary-safe, so screenshots work. */
export function runAdb(args: string[], timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("adb", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new MobileError(
          "E_TIMEOUT",
          `adb ${args.join(" ")} timed out after ${timeoutMs}ms.`,
          "Check `adb devices`: an offline or wedged device hangs every call.",
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new MobileError(
          "E_ADB",
          `Cannot run adb: ${e.message}`,
          "Install Android platform-tools and put adb on PATH.",
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new MobileError(
            "E_ADB",
            `adb ${args.join(" ")} exited ${code}: ${err.trim().slice(0, 300)}`,
            "Run `adb devices` and confirm the device is authorised and online.",
          ),
        );
        return;
      }
      resolve(Buffer.concat(out));
    });
  });
}

export async function adbText(
  args: string[],
  timeoutMs?: number,
): Promise<string> {
  return (await runAdb(args, timeoutMs)).toString("utf-8");
}

function parseDevices(stdout: string): Device[] {
  return stdout
    .replace(/\r/g, "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model =
        rest.find((r) => r.startsWith("model:"))?.slice("model:".length) ?? "";
      return { serial, state, model };
    });
}

export async function listDevices(): Promise<Device[]> {
  return parseDevices(await adbText(["devices", "-l"]));
}

export async function pickDevice(cfg: MobileConfig): Promise<Device> {
  const all = await listDevices();
  const ready = all.filter((d) => d.state === "device");
  if (cfg.device) {
    const hit = ready.find((d) => d.serial === cfg.device);
    if (!hit) {
      throw new MobileError(
        "E_NO_DEVICE",
        `MOBILE_DEVICE="${cfg.device}" is not an online device.`,
        `Online: ${ready.map((d) => d.serial).join(", ") || "(none)"}.`,
      );
    }
    return hit;
  }
  if (ready.length === 1) return ready[0];
  if (ready.length === 0) {
    const offline = all.length
      ? ` (offline: ${all.map((d) => `${d.serial}=${d.state}`).join(", ")})`
      : "";
    throw new MobileError(
      "E_NO_DEVICE",
      `No Android device or emulator is online${offline}.`,
      "Start an emulator or plug in a device, then retry.",
    );
  }
  throw new MobileError(
    "E_AMBIGUOUS",
    `${ready.length} devices online: ${ready.map((d) => d.serial).join(", ")}.`,
    "Set MOBILE_DEVICE=<serial> to choose one.",
  );
}

export async function shell(serial: string, command: string): Promise<string> {
  return adbText(["-s", serial, "shell", command]);
}

/**
 * Forward a device unix socket to an ephemeral host port. `tcp:0` makes adb
 * choose a free port and print it, which removes every port-collision case the
 * hardcoded 9222 approach has.
 */
export async function forwardSocket(
  serial: string,
  socket: string,
): Promise<number> {
  const out = (
    await adbText(["-s", serial, "forward", "tcp:0", `localabstract:${socket}`])
  ).trim();
  const port = Number(out.split(/\s+/).pop());
  if (!Number.isFinite(port) || port <= 0) {
    throw new MobileError(
      "E_ADB",
      `adb forward returned "${out}".`,
      "The WebView devtools socket is gone; reload the app and retry.",
    );
  }
  return port;
}

export async function removeForward(
  serial: string,
  port: number,
): Promise<void> {
  await runAdb(["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(
    () => undefined,
  );
}

export async function appPids(serial: string, pkg: string): Promise<number[]> {
  const out = await runAdb(["-s", serial, "shell", `pidof ${pkg}`])
    .then((b) => b.toString("utf-8").trim())
    .catch(() => "");
  return out
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function appPid(
  serial: string,
  pkg: string,
): Promise<number | null> {
  const pids = await appPids(serial, pkg);
  return pids[0] ?? null;
}

export type WebviewSocket = { pid: number; socket: string };

/**
 * Android names the WebView devtools socket after the process id. Reading
 * /proc/net/unix is the only discovery path that does not need the app to
 * cooperate, and it works on every API level Capacitor supports.
 */
export async function webviewSockets(serial: string): Promise<WebviewSocket[]> {
  const out = await shell(serial, "cat /proc/net/unix").catch(() => "");
  const seen = new Map<number, string>();
  for (const m of out.matchAll(/@?(webview_devtools_remote_(\d+))/g)) {
    seen.set(Number(m[2]), m[1]);
  }
  return [...seen.entries()].map(([pid, socket]) => ({ pid, socket }));
}

export async function launchApp(serial: string, pkg: string): Promise<void> {
  await shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
}

export async function forceStop(serial: string, pkg: string): Promise<void> {
  await shell(serial, `am force-stop ${pkg}`);
}

export async function screencap(serial: string): Promise<Buffer> {
  return runAdb(["-s", serial, "exec-out", "screencap", "-p"], 30_000);
}

export async function logcat(
  serial: string,
  pid: number | null,
  lines: number,
): Promise<string[]> {
  const args = ["-s", serial, "shell", "logcat", "-d", "-t", String(lines)];
  if (pid) args.push(`--pid=${pid}`);
  const out = await adbText(args, 20_000).catch(() => "");
  return out.replace(/\r/g, "").split("\n").filter(Boolean);
}

/** adb keyevent: app-level Back is the activity's, not the WebView's. */
export async function keyevent(
  serial: string,
  code: number | string,
): Promise<void> {
  await shell(serial, `input keyevent ${code}`);
}
