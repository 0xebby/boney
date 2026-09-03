/**
 * Progress reporting for the reporting scripts' long reads.
 *
 * A scan spends minutes inside `eth_getLogs`, so it has to say so or a working pass is
 * indistinguishable from a hung one. In-place redraw needs a terminal; when stdout is a pipe the same
 * text goes out as whole lines, since a `\r`-only stream is one unbounded line to anything reading it.
 */

/** True when progress can be redrawn in place rather than logged line by line. */
const INTERACTIVE = process.stdout.isTTY === true;

/** Wall-clock of the last progress line, so a captured log gets a line every few seconds. */
let lastProgressAt = 0;

/**
 * Reports how far a long read has got, in whichever form the caller's stdout can show.
 *
 * @param text Progress text, without leading whitespace or a trailing ellipsis.
 * @returns Nothing.
 */
export function progress(text: string): void {
  if (INTERACTIVE) {
    process.stdout.write(`\r    ${text}…`);
    return;
  }
  const now = Date.now();
  if (now - lastProgressAt < 2_000) return;
  lastProgressAt = now;
  console.log(`    ${text}…`);
}

/**
 * Clears the in-place progress line, if one was drawn.
 *
 * @returns Nothing.
 */
export function progressDone(): void {
  if (INTERACTIVE) process.stdout.write("\r\x1b[K");
  lastProgressAt = 0;
}
