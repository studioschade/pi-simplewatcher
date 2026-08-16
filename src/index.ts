import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// simplewatcher — generic file/directory watcher that injects new content
// into the pi session as it appears, so the agent can react without waiting
// for the next user prompt.
//
// Two reaction modes per target:
//   - "active"  — triggers an immediate turn even while idle (the agent can
//                 speak/act purely because the watched path changed).
//   - "passive" — queued as context; surfaces at the agent's next natural
//                 turn instead of interrupting anything. Never speaks
//                 unprompted.
//
// File targets are tailed: only content appended since the watch started is
// injected (log-style). Directory targets are watched flat (one level, no
// recursion): every file present when the watch starts, plus anything
// created afterward, is treated as "new" and injected once — this is a
// deliberate backlog catch-up so pending items aren't missed just because
// the watch started after they arrived.

type Mode = "active" | "passive";
type Scope = "project" | "global";

interface WatchTarget {
  targetPath: string;
  mode: Mode;
  isDir: boolean;
  watcher: fs.FSWatcher;
  debounce?: NodeJS.Timeout;
  // file mode
  offset?: number;
  // dir mode
  seen?: Set<string>;
}

interface PersistedWatch {
  path: string;
  mode: Mode;
  enabled?: boolean;
}

interface PersistedConfig {
  version: number;
  watches: PersistedWatch[];
  // Master on/off switch (/simplewatcher disable). Lives in the GLOBAL config
  // only; absent === enabled (matches simplesay's convention). Distinct from
  // the per-watch `enabled` on PersistedWatch.
  enabled?: boolean;
}

const DEBOUNCE_MS = 200;
// Hard ceiling on injected payload size so a watched file/log can't dump an
// unbounded blob into the context window. Override with SIMPLEWATCHER_MAX_BYTES.
const MAX_INJECT_BYTES = Number(process.env.SIMPLEWATCHER_MAX_BYTES ?? 32 * 1024);
const CONFIG_VERSION = 1;

export default function (pi: ExtensionAPI) {
  const targets = new Map<string, WatchTarget>();

  // Master switch: /simplewatcher disable stops all live watches, refuses new
  // ones, and persists across sessions (lives in the global config). Mirrors
  // simplesay's /simplesay disable.
  let enabled = loadMasterEnabled();

  function homeDir() {
    return process.env.HOME ?? "";
  }

  function expandPath(inputPath: string) {
    if (inputPath === "~") return homeDir();
    if (inputPath.startsWith("~/")) return path.join(homeDir(), inputPath.slice(2));
    return path.resolve(inputPath);
  }

  function displayPath(resolved: string) {
    const home = homeDir();
    if (home && (resolved === home || resolved.startsWith(home + path.sep))) {
      return `~${resolved.slice(home.length)}`;
    }
    return resolved;
  }

  function configPath(scope: Scope) {
    return scope === "global"
      ? path.join(homeDir(), ".pi", "agent", "simplewatcher.json")
      : path.join(process.cwd(), ".pi", "simplewatcher.json");
  }

  function emptyConfig(): PersistedConfig {
    return { version: CONFIG_VERSION, watches: [] };
  }

  function readConfig(scope: Scope, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }): PersistedConfig {
    const file = configPath(scope);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return emptyConfig();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
      return { version: CONFIG_VERSION, watches: Array.isArray(parsed.watches) ? parsed.watches : [], enabled: parsed.enabled };
    } catch (err) {
      ctx.ui.notify(`simplewatcher: ignoring invalid ${scope} config ${file}: ${(err as Error).message}`, "warning");
      return emptyConfig();
    }
  }

  function writeConfig(scope: Scope, cfg: PersistedConfig) {
    const file = configPath(scope);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  }

  // Master switch persistence — global config only. Absent key === enabled.
  function loadMasterEnabled(): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath("global"), "utf8")) as Partial<PersistedConfig>;
      return parsed.enabled !== false;
    } catch {
      return true;
    }
  }
  function saveMasterEnabled(value: boolean, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    const cfg = readConfig("global", ctx);
    cfg.enabled = value;
    writeConfig("global", cfg);
  }

  function loadPersisted(ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    // Global first, project second so project wins on the same resolved path.
    const byResolved = new Map<string, PersistedWatch>();
    for (const scope of ["global", "project"] as const) {
      for (const watch of readConfig(scope, ctx).watches) {
        if (!watch || typeof watch.path !== "string") continue;
        if (watch.mode !== "active" && watch.mode !== "passive") continue;
        if (watch.enabled === false) continue;
        byResolved.set(expandPath(watch.path), watch);
      }
    }
    return [...byResolved.values()];
  }

  function persistWatch(inputPath: string, mode: Mode, scope: Scope, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    const resolved = expandPath(inputPath);
    const cfg = readConfig(scope, ctx);
    cfg.watches = cfg.watches.filter((watch) => expandPath(watch.path) !== resolved);
    cfg.watches.push({ path: displayPath(resolved), mode, enabled: true });
    writeConfig(scope, cfg);
    ctx.ui.notify(`simplewatcher: persisted ${displayPath(resolved)} (${scope}, ${mode}) in ${configPath(scope)}`, "info");
  }

  function forgetPersisted(resolved: string, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    let removed = 0;
    for (const scope of ["global", "project"] as const) {
      const cfg = readConfig(scope, ctx);
      const next = cfg.watches.filter((watch) => expandPath(watch.path) !== resolved);
      if (next.length !== cfg.watches.length) {
        removed += cfg.watches.length - next.length;
        writeConfig(scope, { ...cfg, watches: next });
      }
    }
    return removed;
  }

  function inject(targetPath: string, mode: Mode, label: string, content: string) {
    if (!content.trim()) return;
    const totalBytes = Buffer.byteLength(content, "utf8");
    let payload = content;
    if (Number.isFinite(MAX_INJECT_BYTES) && MAX_INJECT_BYTES > 0 && totalBytes > MAX_INJECT_BYTES) {
      payload = `${Buffer.from(content, "utf8").subarray(0, MAX_INJECT_BYTES).toString("utf8")}\n\n[simplewatcher: truncated ${label} — ${totalBytes} bytes total, injected first ${MAX_INJECT_BYTES}]`;
    }
    pi.sendMessage(
      {
        customType: "simplewatcher",
        content: `[simplewatcher: ${label} changed]\n\n${payload}`,
        display: true,
      },
      {
        deliverAs: "steer",
        triggerTurn: mode === "active",
      },
    );
  }

  function readAppended(targetPath: string, t: WatchTarget) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      return;
    }
    let offset = t.offset ?? 0;
    if (stat.size < offset) offset = 0; // truncated/rotated — start over
    if (stat.size <= offset) return;

    const fd = fs.openSync(targetPath, "r");
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, offset);
    } finally {
      fs.closeSync(fd);
    }
    t.offset = stat.size;
    inject(targetPath, t.mode, targetPath, buf.toString("utf8"));
  }

  function scanDir(targetPath: string, t: WatchTarget, modeOverride?: Mode) {
    let files: string[];
    try {
      files = fs.readdirSync(targetPath);
    } catch {
      return;
    }
    const seen = t.seen ?? new Set<string>();
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      const full = path.join(targetPath, f);
      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue; // e.g. archived/moved between readdir and read
      }
      inject(targetPath, modeOverride ?? t.mode, f, content);
    }
    t.seen = seen;
  }

  function scheduleDebounced(targetPath: string, run: () => void) {
    const t = targets.get(targetPath);
    if (!t) return;
    if (t.debounce) clearTimeout(t.debounce);
    t.debounce = setTimeout(run, DEBOUNCE_MS);
  }

  function addWatch(targetPath: string, mode: Mode, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    if (!enabled) {
      ctx.ui.notify("simplewatcher is disabled — run /simplewatcher enable first", "warning");
      return false;
    }
    const resolved = expandPath(targetPath);
    const existing = targets.get(resolved);
    // Carry already-injected state across a RE-ARM of the same path. Dropping it
    // replays the entire backlog, because `session_start` fires again on a MODEL
    // CHANGE — so switching models re-injected every pending file a second time.
    // (sovereign, 2026-07-27: axiom's 23 stale bus messages were injected on boot
    // and again the moment Allen switched models. Each replay is ~23 turn-triggering
    // steers, which starves the prompt bar — submit clears the box and nothing
    // appears to happen. Diagnosed as a "lockup"; it is a turn storm.)
    let carriedSeen: Set<string> | undefined;
    let carriedOffset: number | undefined;
    if (existing) {
      carriedSeen = existing.seen;
      carriedOffset = existing.offset;
      try {
        existing.watcher.close();
      } catch {
        // ignore
      }
      if (existing.debounce) clearTimeout(existing.debounce);
      targets.delete(resolved);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      ctx.ui.notify(`simplewatcher: path does not exist: ${resolved}`, "error");
      return false;
    }

    const isDir = stat.isDirectory();
    const watcher = fs.watch(resolved, () => {
      scheduleDebounced(resolved, () => {
        const t = targets.get(resolved);
        if (!t) return;
        if (t.isDir) scanDir(resolved, t);
        else readAppended(resolved, t);
      });
    });
    // An unhandled FSWatcher "error" event throws; report it instead.
    watcher.on("error", (err) => ctx.ui.notify(`simplewatcher: watch error on ${resolved}: ${err.message}`, "error"));

    const target: WatchTarget = {
      targetPath: resolved,
      mode,
      isDir,
      watcher,
      // file mode: resume where the previous watch left off; otherwise start from
      // the current end (tail), not a full replay
      offset: isDir ? undefined : (carriedOffset ?? stat.size),
      seen: isDir ? (carriedSeen ?? new Set<string>()) : undefined,
    };
    targets.set(resolved, target);

    if (isDir) {
      // Catch-up is PASSIVE regardless of the target's mode. Files that were
      // already sitting there are a backlog, not events: surfacing them as
      // context at the next natural turn is the whole point, whereas firing one
      // turn per pending file means the session spends minutes acting on stale
      // work before it will look at what the user just typed. New arrivals
      // (fs.watch, above) still honour `mode` — that's the live-injection
      // feature, and it is untouched.
      scanDir(resolved, target, "passive");
    }

    ctx.ui.notify(`simplewatcher: watching ${resolved} (${isDir ? "dir" : "file"}, ${mode})`, "info");
    return true;
  }

  function removeWatch(targetPath: string, ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    const resolved = expandPath(targetPath);
    const t = targets.get(resolved);
    if (!t) {
      ctx.ui.notify(`simplewatcher: not watching ${resolved}`, "warning");
      return;
    }
    try {
      t.watcher.close();
    } catch {
      // ignore
    }
    if (t.debounce) clearTimeout(t.debounce);
    targets.delete(resolved);
    const forgotten = forgetPersisted(resolved, ctx);
    ctx.ui.notify(
      `simplewatcher: stopped watching ${resolved}${forgotten ? `; removed ${forgotten} persisted entr${forgotten === 1 ? "y" : "ies"}` : ""}`,
      "info",
    );
  }

  function stopAll() {
    for (const t of targets.values()) {
      try {
        t.watcher.close();
      } catch {
        // ignore
      }
      if (t.debounce) clearTimeout(t.debounce);
    }
    targets.clear();
  }

  // Re-arm persisted watches first, then the env-derived default bus inbox if
  // the same resolved path was not already armed by config. The default agent
  // name is parameterized (SIMPLEWATCHER_AGENT, then PI_AGENT/AGENT_NAME), with
  // a fabricant fallback for backward compatibility.
  // Arm persisted watches + the env-derived default bus inbox. Shared by
  // session_start and /simplewatcher enable so re-enabling re-arms identically
  // to a fresh session.
  function armDefaults(ctx: { ui: { notify: (m: string, k: "info" | "warning" | "error") => void } }) {
    const armed = new Set<string>();
    for (const watch of loadPersisted(ctx)) {
      if (addWatch(watch.path, watch.mode, ctx)) armed.add(expandPath(watch.path));
    }

    const agent = process.env.SIMPLEWATCHER_AGENT ?? process.env.PI_AGENT ?? process.env.AGENT_NAME ?? "fabricant";
    const busInbox = path.join(homeDir(), "Agents", "_bus", "inbox", agent);
    if (fs.existsSync(busInbox) && !armed.has(path.resolve(busInbox))) {
      addWatch(busInbox, "active", ctx);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!enabled) return; // disabled: don't arm (and don't re-arm on model change)
    armDefaults(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopAll();
  });

  pi.registerCommand("simplewatcher", {
    description: "Watch a file or directory, injecting new content into context. /simplewatcher <path> [--active|--passive] [--persist [--global]], /simplewatcher remove <path>, /simplewatcher persisted, /simplewatcher enable|disable, /simplewatcher (list)",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();

      if (!trimmed) {
        if (!enabled) {
          ctx.ui.notify("simplewatcher: DISABLED — /simplewatcher enable to resume", "info");
          return;
        }
        if (targets.size === 0) {
          ctx.ui.notify("simplewatcher: no active watches", "info");
          return;
        }
        const lines = [...targets.values()].map(
          (t) => `${t.targetPath} (${t.isDir ? "dir" : "file"}, ${t.mode})`,
        );
        ctx.ui.notify(`simplewatcher watching:\n${lines.join("\n")}`, "info");
        return;
      }

      if (trimmed === "persisted") {
        const blocks = (["project", "global"] as const).map((scope) => {
          const cfg = readConfig(scope, ctx);
          const lines = cfg.watches.map((w) => `${w.path} (${w.mode}${w.enabled === false ? ", disabled" : ""})`);
          return `${scope}: ${configPath(scope)}\n${lines.length ? lines.join("\n") : "  (none)"}`;
        });
        ctx.ui.notify(`simplewatcher persisted watches:\n${blocks.join("\n")}`, "info");
        return;
      }

      if (trimmed === "disable" || trimmed === "off") {
        if (!enabled) { ctx.ui.notify("simplewatcher already disabled", "info"); return; }
        enabled = false;
        saveMasterEnabled(false, ctx);
        stopAll();
        ctx.ui.notify("simplewatcher disabled (saved) — all watches stopped; /simplewatcher enable to resume", "info");
        return;
      }
      if (trimmed === "enable" || trimmed === "on") {
        if (enabled) { ctx.ui.notify("simplewatcher already enabled", "info"); return; }
        enabled = true;
        saveMasterEnabled(true, ctx);
        stopAll(); // clear any partial state before re-arming
        armDefaults(ctx);
        ctx.ui.notify("simplewatcher enabled (saved) — watches re-armed", "info");
        return;
      }

      const removeMatch = /^remove\s+(.+)$/.exec(trimmed);
      if (removeMatch) {
        removeWatch(removeMatch[1].trim(), ctx);
        return;
      }

      const parts = trimmed.split(/\s+/);
      let mode: Mode = "passive";
      let persist = false;
      let scope: Scope = "project";
      const pathParts: string[] = [];
      for (const p of parts) {
        if (p === "--active") mode = "active";
        else if (p === "--passive") mode = "passive";
        else if (p === "--persist") persist = true;
        else if (p === "--global") scope = "global";
        else if (p === "--local") scope = "project";
        else if (p.startsWith("--")) {
          ctx.ui.notify(`simplewatcher: unknown option ${p}. Usage: /simplewatcher <path> [--active|--passive] [--persist [--global]]`, "error");
          return;
        } else pathParts.push(p);
      }
      const targetPath = pathParts.join(" ");
      if (!targetPath) {
        ctx.ui.notify("simplewatcher: usage: /simplewatcher <path> [--active|--passive] [--persist [--global]]", "error");
        return;
      }
      if (addWatch(targetPath, mode, ctx) && persist) {
        persistWatch(targetPath, mode, scope, ctx);
      }
    },
  });
}
