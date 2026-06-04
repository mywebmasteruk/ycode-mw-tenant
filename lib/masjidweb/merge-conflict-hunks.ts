/** Extract `<<<<<<<` … `>>>>>>>` hunks from a merged file for chunked AI repair. */

export function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<<|^=======|^>>>>>>>/m.test(content);
}

export function extractConflictHunks(content: string): string[] {
  const lines = content.split('\n');
  const hunks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
      i += 1;
    }
    if (i >= lines.length) {
      throw new Error('Conflict hunk missing closing >>>>>>> marker');
    }
    hunks.push(lines.slice(start, i + 1).join('\n'));
    i += 1;
  }

  return hunks;
}

export function replaceConflictHunk(
  content: string,
  hunk: string,
  resolved: string,
): string {
  const index = content.indexOf(hunk);
  if (index === -1) {
    throw new Error('Conflict hunk not found in file (content may have shifted)');
  }
  return content.slice(0, index) + resolved + content.slice(index + hunk.length);
}
