/**
 * Offline / persistent event spool for @allstak/nestjs.
 *
 * Goal: buffered telemetry must survive a process restart AND a network
 * outage. When an event cannot be delivered (network error, retry exhausted,
 * offline, or the process is shutting down with events still buffered) the
 * transport writes the ALREADY-PII-SCRUBBED wire body to a filesystem spool
 * instead of dropping it. On the next init the transport drains the spool and
 * re-sends each entry through the normal pipeline, removing an entry only after
 * it is accepted (2xx) or is permanently undeliverable (a 4xx other than 429).
 *
 * This follows the standard offline-transport pattern (envelopes persisted to a
 * cache dir and replayed on the next start) using the idiomatic Node mechanism:
 * a spool directory with one small JSON file per envelope.
 *
 * Design constraints honoured here:
 *   - SCRUB BEFORE PERSIST: callers pass the scrubbed JSON body string; this
 *     module never re-derives or stores the raw payload.
 *   - BOUNDED: capped by count, total bytes, and max age. When full the OLDEST
 *     entry is evicted. Never grows unbounded.
 *   - GRACEFUL DEGRADATION: every operation is wrapped so a read-only FS,
 *     serverless/edge runtime (no `fs`), or sandbox degrades silently to the
 *     existing in-memory behaviour. NEVER throws into capture or init.
 *
 * One file per envelope keeps writes atomic-ish and makes drop-oldest / remove
 * trivial (sorted by the monotonic timestamp prefix in the filename), without
 * pulling in a native dependency.
 */

/** Defaults: a few MB / ~100 envelopes / 48h, sane for a server runtime. */
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h
const FILE_PREFIX = 'allstak-';
const FILE_SUFFIX = '.json';
const DIR_NAME = 'allstak-nestjs-spool';

export interface SpoolOptions {
  /** Spool directory. Defaults to `<os.tmpdir()>/allstak-nestjs-spool`. */
  dir?: string;
  /** Max number of envelopes retained on disk. Default 100. */
  maxEntries?: number;
  /** Max total bytes retained on disk. Default 5 MB. */
  maxBytes?: number;
  /** Max envelope age before it is considered stale and dropped. Default 48h. */
  maxAgeMs?: number;
}

/** A spooled envelope read back off disk for replay. */
export interface SpooledEnvelope {
  /** Opaque store key (the filename) — pass to {@link EventSpool.remove}. */
  id: string;
  /** Ingest path the body was destined for (e.g. `/ingest/v1/errors`). */
  path: string;
  /** The already-scrubbed JSON body string, ready to POST verbatim. */
  body: string;
  /** Epoch millis the entry was first persisted. */
  persistedAt: number;
}

/**
 * Minimal slice of `node:fs` the spool needs. Captured behind an interface so a
 * missing/partial fs (edge runtime) is detected once and the spool no-ops.
 */
interface FsLike {
  mkdirSync(p: string, opts: { recursive: boolean }): void;
  writeFileSync(p: string, data: string): void;
  readFileSync(p: string, enc: 'utf8'): string;
  readdirSync(p: string): string[];
  statSync(p: string): { size: number };
  unlinkSync(p: string): void;
  existsSync(p: string): boolean;
}

interface PathLike {
  join(...parts: string[]): string;
}

/** True when running on a Node process (mirrors release.ts isNodeRuntime). */
function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!proc?.versions?.node;
}

/**
 * Lazily resolve a node builtin WITHOUT a static import — mirrors the
 * bundle-safe loader in release.ts: `process.getBuiltinModule` first, then an
 * indirect require off the CommonJS wrapper. Returns null on any failure so a
 * non-Node / edge runtime (no `fs`) degrades silently.
 */
function loadBuiltin<T>(id: string): T | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => T } }).process;
  try {
    const fromBuiltin = proc?.getBuiltinModule?.(id);
    if (fromBuiltin) return fromBuiltin;
  } catch {
    /* fall through */
  }
  try {
    const req =
      (globalThis as { require?: (id: string) => T }).require ??
      (typeof module !== 'undefined' && (module as { require?: (id: string) => T }).require);
    return req ? req(id) : null;
  } catch {
    return null;
  }
}

/** Lazily resolve node fs/path/os without a hard dependency (edge-safe). */
function loadNodeModules(): { fs: FsLike; path: PathLike; tmpdir: () => string } | null {
  if (!isNodeRuntime()) return null;
  try {
    const fs = loadBuiltin<FsLike>('node:fs');
    const path = loadBuiltin<PathLike>('node:path');
    const os = loadBuiltin<{ tmpdir: () => string }>('node:os');
    if (!fs || !path || !os || typeof fs.writeFileSync !== 'function') return null;
    return { fs, path, tmpdir: () => os.tmpdir() };
  } catch {
    return null;
  }
}

let counter = 0;

/** Monotonic, sortable filename: `allstak-<ts>-<seq>-<rand>.json`. */
function makeFilename(now: number): string {
  const seq = (counter = (counter + 1) % 1_000_000).toString().padStart(6, '0');
  const ts = now.toString().padStart(15, '0');
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `${FILE_PREFIX}${ts}-${seq}-${rand}${FILE_SUFFIX}`;
}

/** Parse the persisted-at epoch millis back out of a spool filename. */
function timestampOf(filename: string): number {
  const m = filename.slice(FILE_PREFIX.length).split('-')[0];
  const n = Number(m);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Filesystem-backed bounded event spool. All public methods are fail-open: any
 * fs error degrades silently (the SDK falls back to in-memory behaviour) and
 * NEVER throws into capture, init, or shutdown.
 */
export class EventSpool {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly nodeModules: { fs: FsLike; path: PathLike; tmpdir: () => string } | null;
  private readonly dir: string | null;
  /** True when the spool is usable (node fs present + dir writable). */
  private readonly enabled: boolean;

  constructor(opts: SpoolOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.nodeModules = loadNodeModules();
    if (!this.nodeModules) {
      this.dir = null;
      this.enabled = false;
      return;
    }
    this.dir = opts.dir || this.nodeModules.path.join(this.nodeModules.tmpdir(), DIR_NAME);
    // Probe writability ONCE at construction. A read-only FS / sandbox flips
    // `enabled` to false and the spool no-ops for the rest of its life.
    this.enabled = this.ensureDir();
  }

  /** Whether the spool is backed by a writable directory. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Resolved spool directory (null when degraded to in-memory). */
  location(): string | null {
    return this.enabled ? this.dir : null;
  }

  private ensureDir(): boolean {
    if (!this.nodeModules || !this.dir) return false;
    try {
      this.nodeModules.fs.mkdirSync(this.dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persist a scrubbed envelope body. The `body` MUST already be PII-scrubbed
   * (the transport passes the same JSON string it would have sent on the wire).
   * Returns false on any failure so the caller can fall back to dropping.
   */
  persist(path: string, body: string, now: number = Date.now()): boolean {
    if (!this.enabled || !this.nodeModules || !this.dir) return false;
    try {
      const filename = makeFilename(now);
      const record = JSON.stringify({ v: 1, path, body, persistedAt: now });
      this.nodeModules.fs.writeFileSync(this.nodeModules.path.join(this.dir, filename), record);
      // Enforce bounds AFTER writing so the newest entry is always retained and
      // only OLDEST entries are evicted when over the cap.
      this.enforceBounds();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load all persisted envelopes (oldest first), pruning stale ones older than
   * `maxAgeMs` as a side effect. Returns an empty list on any failure.
   */
  load(now: number = Date.now()): SpooledEnvelope[] {
    if (!this.enabled || !this.nodeModules || !this.dir) return [];
    const out: SpooledEnvelope[] = [];
    try {
      const files = this.listSorted();
      for (const file of files) {
        const full = this.nodeModules.path.join(this.dir, file);
        if (now - timestampOf(file) > this.maxAgeMs) {
          this.safeUnlink(full);
          continue;
        }
        try {
          const raw = this.nodeModules.fs.readFileSync(full, 'utf8');
          const parsed = JSON.parse(raw) as { path?: string; body?: string; persistedAt?: number };
          if (typeof parsed.path === 'string' && typeof parsed.body === 'string') {
            out.push({ id: file, path: parsed.path, body: parsed.body, persistedAt: parsed.persistedAt ?? timestampOf(file) });
          } else {
            this.safeUnlink(full); // corrupt / unknown shape — drop it
          }
        } catch {
          this.safeUnlink(full); // unreadable / malformed — drop it
        }
      }
    } catch {
      return out;
    }
    return out;
  }

  /** Remove a single persisted entry by its store key (filename). No-op on error. */
  remove(id: string): void {
    if (!this.enabled || !this.nodeModules || !this.dir) return;
    this.safeUnlink(this.nodeModules.path.join(this.dir, id));
  }

  /** Current number of persisted entries (best-effort; 0 on error or degraded). */
  size(): number {
    if (!this.enabled || !this.nodeModules || !this.dir) return 0;
    try {
      return this.listSorted().length;
    } catch {
      return 0;
    }
  }

  private listSorted(): string[] {
    if (!this.nodeModules || !this.dir) return [];
    return this.nodeModules.fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
      .sort(); // filenames are timestamp-prefixed ⇒ lexical sort == oldest first
  }

  /** Drop OLDEST entries until under the count and byte caps. Best-effort. */
  private enforceBounds(): void {
    if (!this.nodeModules || !this.dir) return;
    try {
      let files = this.listSorted();
      // Count cap.
      while (files.length > this.maxEntries) {
        this.safeUnlink(this.nodeModules.path.join(this.dir, files[0]));
        files = files.slice(1);
      }
      // Byte cap.
      let total = 0;
      const sizes: number[] = [];
      for (const f of files) {
        let size = 0;
        try {
          size = this.nodeModules.fs.statSync(this.nodeModules.path.join(this.dir, f)).size;
        } catch {
          size = 0;
        }
        sizes.push(size);
        total += size;
      }
      let i = 0;
      while (total > this.maxBytes && i < files.length) {
        this.safeUnlink(this.nodeModules.path.join(this.dir, files[i]));
        total -= sizes[i];
        i++;
      }
    } catch {
      /* eviction is best-effort */
    }
  }

  private safeUnlink(full: string): void {
    if (!this.nodeModules) return;
    try {
      this.nodeModules.fs.unlinkSync(full);
    } catch {
      /* already gone / unwritable — ignore */
    }
  }
}
