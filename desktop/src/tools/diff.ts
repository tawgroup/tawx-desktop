const CONTEXT_LINES = 3;

function lines(value: string): string[] {
  if (value === '') return [];
  const result = value.split('\n');
  if (result[result.length - 1] === '') result.pop();
  return result;
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * Produces a bounded-work unified diff. A changed middle is emitted as one hunk
 * instead of using a quadratic line-matching algorithm on model-sized files.
 */
export function createUnifiedDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return '';

  const oldLines = lines(before ?? '');
  const newLines = lines(after ?? '');
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldStart = Math.max(0, prefix - CONTEXT_LINES);
  const newStart = Math.max(0, prefix - CONTEXT_LINES);
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const oldEnd = Math.min(oldLines.length, oldChangedEnd + CONTEXT_LINES);
  const newEnd = Math.min(newLines.length, newChangedEnd + CONTEXT_LINES);
  const leadingContext = prefix - oldStart;

  const body: string[] = [];
  for (let index = oldStart; index < prefix; index += 1) body.push(` ${oldLines[index]}`);
  for (let index = prefix; index < oldChangedEnd; index += 1) body.push(`-${oldLines[index]}`);
  for (let index = prefix; index < newChangedEnd; index += 1) body.push(`+${newLines[index]}`);

  const trailingContext = Math.min(oldEnd - oldChangedEnd, newEnd - newChangedEnd);
  for (let offset = 0; offset < trailingContext; offset += 1) {
    body.push(` ${oldLines[oldChangedEnd + offset]}`);
  }

  const oldCount = leadingContext + (oldChangedEnd - prefix) + trailingContext;
  const newCount = leadingContext + (newChangedEnd - prefix) + trailingContext;
  const oldLabel = before === null ? '/dev/null' : `a/${path}`;
  const newLabel = after === null ? '/dev/null' : `b/${path}`;
  const oldLine = oldCount === 0 ? 0 : oldStart + 1;
  const newLine = newCount === 0 ? 0 : newStart + 1;

  return [
    `--- ${oldLabel}`,
    `+++ ${newLabel}`,
    `@@ -${range(oldLine, oldCount)} +${range(newLine, newCount)} @@`,
    ...body,
    '',
  ].join('\n');
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return { value, truncated: false };

  const marker = `\n[output truncated at ${maxBytes} bytes]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) {
    return { value: Buffer.from(marker).subarray(0, maxBytes).toString('utf8'), truncated: true };
  }

  const prefixBudget = maxBytes - markerBytes;
  let prefix = encoded.subarray(0, prefixBudget).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > prefixBudget) prefix = prefix.slice(0, -1);
  return { value: prefix + marker, truncated: true };
}
