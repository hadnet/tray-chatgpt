import { execFile } from "child_process";
import { readdir, stat } from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const execute = promisify(execFile);

// Polling also catches files whose screenshot metadata arrives after creation.
export function watchScreenshots(options: {
  desktop: string;
  home: string;
  copy: (file: string) => boolean;
  onError: (message: string) => void;
}) {
  const startedAt = Date.now();
  const candidates = new Map<string, {
    signature: string;
    attempts: number;
    createdAt: number;
  }>();
  const finished = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let folder = options.desktop;
  let nextLocationCheck = 0;

  async function scan() {
    try {
      if (Date.now() >= nextLocationCheck) {
        try {
          const { stdout } = await execute("/usr/bin/defaults", [
            "read", "com.apple.screencapture", "location",
          ], { timeout: 2000 });
          const location = stdout.trim();
          folder = location.startsWith("~/")
            ? path.join(options.home, location.slice(2))
            : path.isAbsolute(location) ? location : options.desktop;
        } catch {
          folder = options.desktop;
        }
        nextLocationCheck = Date.now() + 5000;
      }
      if (stopped) return;
      const entries = await readdir(folder, { withFileTypes: true });
      // Keep a short history without replaying screenshots after sleep/resume.
      const cutoff = Math.max(startedAt, Date.now() - 60_000);
      for (const entry of entries) {
        if (stopped) return;
        if (!entry.isFile() || !/\.(png|jpe?g|tiff?|heic)$/i.test(entry.name)) continue;
        const file = path.join(folder, entry.name);
        try {
          const info = await stat(file);
          // Existing files must never replace the clipboard at startup.
          if (info.birthtimeMs < cutoff) continue;
          const identity = `${file}:${info.birthtimeMs}`;
          if (finished.has(identity)) continue;
          const signature = `${info.size}:${info.mtimeMs}`;
          const previous = candidates.get(identity);
          candidates.set(identity, {
            signature,
            attempts: previous?.signature === signature ? previous.attempts + 1 : 0,
            createdAt: info.birthtimeMs,
          });
          if (previous?.signature === signature && previous.attempts >= 15) {
            candidates.delete(identity);
            finished.set(identity, info.birthtimeMs);
            continue;
          }
          if (!info.size || previous?.signature !== signature) continue;
          await execute("/usr/bin/xattr", [
            "-p", "com.apple.metadata:kMDItemIsScreenCapture", file,
          ], { timeout: 2000 });
          if (stopped) return;
          if (options.copy(file)) {
            finished.set(identity, info.birthtimeMs);
            candidates.delete(identity);
          }
        } catch {
          // A file can disappear, still be saving, or not be a screenshot.
        }
      }
      for (const [identity, createdAt] of finished) {
        if (createdAt < cutoff) finished.delete(identity);
      }
      for (const [identity, candidate] of candidates) {
        if (candidate.createdAt < cutoff) candidates.delete(identity);
      }
      if (!stopped) options.onError("");
    } catch {
      if (!stopped) options.onError("Cannot read the screenshot folder. Check its location and allow folder access in macOS Privacy & Security settings.");
    } finally {
      if (!stopped) timer = setTimeout(scan, 1000);
    }
  }

  void scan();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
