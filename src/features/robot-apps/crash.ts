/**
 * The lines of a crashed app's error worth showing on a phone.
 *
 * The daemon reports `Process exited with code N` followed by the app's last
 * stderr lines. The first line is the verdict and the last ones usually hold
 * the exception; the middle is startup noise.
 */
export function crashSummary(error: string, tailLines = 4): string[] {
  const lines = error.split('\n').filter(line => line.trim() !== '');
  if (lines.length <= tailLines + 1) return lines;
  return [lines[0], '…', ...lines.slice(-tailLines)];
}
