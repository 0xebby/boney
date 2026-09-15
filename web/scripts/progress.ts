/** Progress output for long reporting-script reads. */

/** Whether progress can redraw in place. */
const INTERACTIVE = process.stdout.isTTY === true;

/** Last non-interactive progress output time. */
let lastProgressAt = 0;

/**
 * Reports progress in the format supported by stdout.
 *
 * @param text Progress text without indentation or a trailing ellipsis.
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
 * Clears interactive progress and resets output throttling.
 *
 * @returns Nothing.
 */
export function progressDone(): void {
  if (INTERACTIVE) process.stdout.write("\r\x1b[K");
  lastProgressAt = 0;
}
