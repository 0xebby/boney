/**
 * Formatting helpers.
 *
 * Pure functions, no React — these carry the density conventions of a data terminal and are
 * where off-by-one and rounding bugs hide, so they are unit-tested directly.
 */

/**
 * Compact number: 1,284 → "1,284"; 12,900 → "12.9K"; 4,200,000 → "4.2M".
 * Below 10,000 stays exact, because a campaign with 1,284 mints should read as 1,284.
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);

  if (abs < 10_000) return value.toLocaleString("en-US");
  if (abs < 1_000_000) return `${trim(value / 1_000)}K`;
  if (abs < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}

function trim(n: number): string {
  // One decimal, but drop a trailing ".0" — "12K" reads better than "12.0K".
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Formats a token amount from base units.
 * Uses BigInt division so precision is never lost to float conversion on large balances.
 */
export function formatTokenAmount(
  raw: bigint,
  decimals: number,
  opts: {maxFractionDigits?: number; compact?: boolean} = {},
): string {
  const {maxFractionDigits = 2, compact = false} = opts;

  if (decimals < 0) throw new RangeError("decimals must be >= 0");

  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;
  const base = BigInt(10) ** BigInt(decimals);

  const whole = abs / base;
  const fraction = abs % base;

  if (compact && whole >= BigInt(10_000)) {
    return `${negative ? "-" : ""}${compactNumber(Number(whole))}`;
  }

  let out = whole.toLocaleString("en-US");

  if (maxFractionDigits > 0 && fraction > BigInt(0)) {
    // Pad to full width, then trim to the requested precision and drop trailing zeros.
    const fracStr = fraction.toString().padStart(decimals, "0").slice(0, maxFractionDigits);
    const trimmed = fracStr.replace(/0+$/, "");
    if (trimmed) out += `.${trimmed}`;
  }

  return `${negative ? "-" : ""}${out}`;
}

/**
 * Exact base-units → decimal string, suitable for putting *into* an amount input.
 *
 * Deliberately not `formatTokenAmount`: that one is for display and does two things that corrupt
 * a form value. It groups with commas (`8,000`), which `parseAmount` rejects outright, and it
 * truncates to two fraction digits, which silently rounds the amount *down* — prefilling a
 * "fund the shortfall" box with a truncated value would leave the campaign a few wei short and
 * `activate()` would revert with `NotFunded` for no visible reason.
 *
 * The output round-trips: `parseAmount(toAmountInput(v, d), d) === v` for every v and d.
 */
export function toAmountInput(raw: bigint, decimals: number): string {
  if (decimals < 0) throw new RangeError("decimals must be >= 0");

  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;
  const base = BigInt(10) ** BigInt(decimals);

  const whole = (abs / base).toString();
  if (decimals === 0) return `${negative ? "-" : ""}${whole}`;

  // Keep every significant digit; only trailing zeros of the fraction are dropped, and those
  // do not change the value.
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Percentage with one decimal: 0.4567 → "45.7%". Guards divide-by-zero. */
export function formatPercent(value: number, total: number): string {
  if (total === 0) return "0%";
  const pct = (value / total) * 100;
  if (!Number.isFinite(pct)) return "—";
  const s = pct.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}

/** Percentage from a ratio already in 0..1. */
export function formatRatio(ratio: number): string {
  return formatPercent(ratio, 1);
}

/** Truncated address: 0x1234…cdef */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Human duration from seconds: "3d 4h", "12h 30m", "45m", "just now".
 * Returns at most two units — a data terminal shows "3d 4h", never "3d 4h 12m 6s".
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return s === 0 ? "just now" : `${s}s`;

  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/**
 * Relative time against a unix timestamp (seconds).
 * `nowSeconds` is injectable so tests are deterministic rather than clock-dependent.
 */
export function formatTimeUntil(target: bigint | number, nowSeconds: number): string {
  const t = typeof target === "bigint" ? Number(target) : target;
  const delta = t - nowSeconds;
  if (delta <= 0) return "ended";
  return formatDuration(delta);
}

/** Absolute date, e.g. "12 Aug 2026". */
export function formatDate(unixSeconds: bigint | number): string {
  const t = typeof unixSeconds === "bigint" ? Number(unixSeconds) : unixSeconds;
  return new Date(t * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Absolute date *and* time, e.g. "12 Aug 2026, 14:30". For a field being edited to the minute. */
export function formatDateTime(unixSeconds: bigint | number): string {
  const t = typeof unixSeconds === "bigint" ? Number(unixSeconds) : unixSeconds;
  if (!Number.isFinite(t) || t <= 0) return "—";
  return new Date(t * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── datetime-local interop ───────────────────────────────────────

/**
 * Unix seconds → the `YYYY-MM-DDTHH:mm` string an `<input type="datetime-local">` requires.
 *
 * Built out of the *local* getters rather than `toISOString`, and that distinction is the whole
 * reason this is a tested function. `toISOString` yields UTC, which the input then displays as
 * though it were local — so anywhere east or west of Greenwich the field silently shows a time that
 * is hours off the timestamp it came from, and a project setting a start of "09:00" escrows a
 * campaign that opens at 04:00. `padStart` matters for the same class of reason: `2026-8-1T9:05`
 * is not a value the input will accept, and it renders blank instead of erroring.
 *
 * Returns "" for a non-finite or non-positive timestamp, which reads as an empty field rather than
 * "01 Jan 1970".
 */
export function toDateTimeLocal(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "";
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The inverse: a `datetime-local` value → unix seconds, or 0 when it cannot be read.
 *
 * `new Date("2026-08-12T14:30")` — no zone suffix — is parsed as local time by every current
 * engine, which is exactly what the input means by it. Zero rather than `NaN` on failure, because
 * the draft field is typed `number` and `NaN` would propagate silently through validation and
 * arrive at `campaignArgs` as a `BigInt(NaN)` throw at submit time, long after the mistake.
 */
export function fromDateTimeLocal(value: string): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

// ── duration interop ─────────────────────────────────────────────

/** Units a duration field offers, largest first. */
export const DURATION_UNITS = [
  {id: "days", label: "days", seconds: 86_400},
  {id: "hours", label: "hours", seconds: 3_600},
  {id: "minutes", label: "minutes", seconds: 60},
  {id: "seconds", label: "seconds", seconds: 1},
] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number]["id"];

/**
 * Split seconds into the largest unit that divides it exactly.
 *
 * Exact division only, so the pair always round-trips: 604800 reads as 7 days, but 604801 reads as
 * 604801 seconds rather than "7 days" — because showing the rounded form would let a save quietly
 * rewrite the value the project actually set. A field that lies by one second is worse than one
 * that shows an awkward number.
 *
 * `seconds` is in the list as the exact-representation floor, not because anyone wants to type a
 * window in seconds. Without it the fallback has to invent a unit for a value no larger unit
 * divides, and `joinDuration` would then multiply it back up into a different number.
 */
export function splitDuration(totalSeconds: number): {value: number; unit: DurationUnit} {
  const s = Math.max(0, Math.floor(totalSeconds));
  for (const unit of DURATION_UNITS) {
    if (s >= unit.seconds && s % unit.seconds === 0) return {value: s / unit.seconds, unit: unit.id};
  }
  return {value: s, unit: "seconds"};
}

/** Recombine a value and unit into seconds. */
export function joinDuration(value: number, unit: DurationUnit): number {
  const found = DURATION_UNITS.find((u) => u.id === unit);
  if (!found || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value) * found.seconds;
}
