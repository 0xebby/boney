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
