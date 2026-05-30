const DEFAULT_REDACTED_KEY_PATTERNS: RegExp[] = [
  /(^|\.)authorization$/i,
  /(^|\.)proxy-authorization$/i,
  /(^|\.)cookie$/i,
  /(^|\.)set-cookie$/i,
  /(^|\.)x-api-key$/i,
  /(^|\.)x-auth-token$/i,
  /(^|\.)x-access-token$/i,
  /(^|\.)x-allstak-key$/i,
  /(^|[._-])token$/i,
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])password$/i,
  /(^|[._-])passwd$/i,
  /(^|[._-])secret$/i,
  /(^|[._-])session[._-]?id$/i,
  /(^|[._-])csrf$/i,
  // Canonical denylist parity additions.
  /(^|[._-])bearer$/i,
  /(^|[._-])jwt$/i,
  /(^|[._-])pwd$/i,
  /(^|[._-])credit[._-]?card$/i,
  /(^|[._-])card[._-]?number$/i,
  /(^|[._-])cvv$/i,
  /(^|[._-])ssn$/i,
];

const REDACTED = '[REDACTED]';

// ───────────────────────────────────────────────────────────────────────────
// Value-pattern scrubbing (free-text data-scrubbing)
//
// Key-based redaction (above) nukes a value when its KEY looks sensitive. This
// layer scrubs PII that leaks into free-text string VALUES regardless of key.
//
// Layering:
//   A) ALWAYS scrub (independent of sendDefaultPii): credit-card numbers that
//      pass the Luhn checksum, and US SSNs (hyphenated form only).
//   B) Scrub UNLESS sendDefaultPii === true: email addresses and IPv4 literals.
//
// Performance: the value scanners are pure regex/replace over bounded strings.
// Patterns are module-level (compiled once). Strings longer than
// MAX_SCAN_LENGTH are passed through unscanned (a pathological multi-megabyte
// blob must never stall the wire path). Recursion is depth-capped so a cyclic
// or deeply nested object cannot blow the stack.
// ───────────────────────────────────────────────────────────────────────────

/** Strings longer than this are not value-scanned (perf guard, fail-open). */
const MAX_SCAN_LENGTH = 16 * 1024;
/** Max object/array nesting walked by the value scrubber. */
const MAX_DEPTH = 8;

// (A) ALWAYS-on patterns.

/**
 * Candidate credit-card runs: 13–19 digits with optional single space/hyphen
 * separators between digits, on a word-ish boundary so we don't slice a run out
 * of a longer alphanumeric token. Each candidate is Luhn-validated before
 * redaction so order ids / long timestamps that merely look card-shaped survive.
 */
const CC_CANDIDATE = /(?<![\dA-Za-z])(?:\d[ -]?){12,18}\d(?![\dA-Za-z])/g;

/** US SSN — REQUIRE the hyphens; never match a bare 9-digit run. */
const SSN_HYPHENATED = /\b\d{3}-\d{2}-\d{4}\b/g;

// (B) PII patterns, gated by sendDefaultPii.

/** Pragmatic email matcher (local@domain.tld). */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * IPv4 with each octet validated 0–255 so we don't redact dotted version
 * strings like 999.1.2.3 or arbitrary 4-number sequences out of range.
 */
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/**
 * Best-effort IPv6 (full and ::-compressed forms). Lookarounds anchor on
 * non-hex/non-colon boundaries (a literal `\b` cannot anchor next to a colon)
 * so plain words and `h:mm:ss` timestamps are not matched. Best-effort only:
 * gated behind sendDefaultPii=false, so an over-match on a hex:colon token is a
 * conservative privacy choice, not a data-corruption regression.
 */
const IPV6 = /(?<![:.\w])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:))(?![:.\w])/g;

/** Luhn (mod-10) checksum over the digits of `s` (separators already allowed). */
function luhnValid(s: string): boolean {
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Apply value-pattern scrubbing to a single string. Returns the string with
 * matched PII replaced by [REDACTED]. `sendDefaultPii` controls only the (B)
 * scrubbers; (A) is always applied. Never throws — on any internal error the
 * input is returned unchanged (the caller's key-based redaction still applies).
 */
export function scrubString(input: string, sendDefaultPii: boolean): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (input.length > MAX_SCAN_LENGTH) return input; // perf guard, fail-open
  try {
    let out = input;
    // (A) ALWAYS: credit cards (Luhn-gated) + hyphenated SSN.
    out = out.replace(CC_CANDIDATE, (m) => (luhnValid(m) ? REDACTED : m));
    out = out.replace(SSN_HYPHENATED, REDACTED);
    // (B) UNLESS sendDefaultPii: email + IPv4/IPv6.
    if (!sendDefaultPii) {
      out = out.replace(EMAIL, REDACTED);
      out = out.replace(IPV4, REDACTED);
      out = out.replace(IPV6, REDACTED);
    }
    return out;
  } catch {
    return input;
  }
}

export interface ValueScrubOptions {
  /** When true, the (B) PII scrubbers (email/IP) are disabled. (A) stays on. */
  sendDefaultPii?: boolean;
  /**
   * Top-level keys whose values must NOT be value-scrubbed (e.g. explicitly
   * set user identity). Compared case-sensitively against the immediate key.
   */
  exemptKeys?: ReadonlySet<string>;
}

/**
 * Recursively value-scrub a string (or the strings inside an object/array).
 * Object KEYS are not scrubbed (key-based redaction owns those); only string
 * VALUES are scanned. `exemptKeys` (top level only) bypasses scrubbing for
 * intentional identity fields. Fail-open and depth/length capped.
 */
export function scrubValues<T>(value: T, opts: ValueScrubOptions = {}): T {
  const sendDefaultPii = opts.sendDefaultPii === true;
  const exempt = opts.exemptKeys;
  return scrubValueInner(value, sendDefaultPii, exempt, 0) as T;
}

function scrubValueInner(
  value: unknown,
  sendDefaultPii: boolean,
  exempt: ReadonlySet<string> | undefined,
  depth: number,
): unknown {
  if (typeof value === 'string') return scrubString(value, sendDefaultPii);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return value; // depth guard, fail-open
  try {
    if (Array.isArray(value)) {
      return value.map((v) => scrubValueInner(v, sendDefaultPii, undefined, depth + 1));
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (depth === 0 && exempt?.has(k)) {
        out[k] = v; // intentional identity field — ship verbatim
      } else {
        out[k] = scrubValueInner(v, sendDefaultPii, exempt, depth + 1);
      }
    }
    return out;
  } catch {
    return value;
  }
}

export function isSensitiveKey(key: string, extra: RegExp[] = []): boolean {
  for (const p of DEFAULT_REDACTED_KEY_PATTERNS) if (p.test(key)) return true;
  for (const p of extra) if (p.test(key)) return true;
  return false;
}

export function compileExtra(extra: (string | RegExp)[] | undefined): RegExp[] {
  if (!extra) return [];
  return extra.map((p) => (p instanceof RegExp ? p : new RegExp(escape(p), 'i')));
}

export function redactMap(input: Record<string, unknown> | undefined, extra: RegExp[] = []): Record<string, unknown> | undefined {
  if (!input) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = isSensitiveKey(k, extra) ? REDACTED : redactValue(v, extra);
  }
  return out;
}

function redactValue(v: unknown, extra: RegExp[]): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) return redactMap(v as Record<string, unknown>, extra);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, extra));
  return v;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const REDACTED_VALUE = REDACTED;
