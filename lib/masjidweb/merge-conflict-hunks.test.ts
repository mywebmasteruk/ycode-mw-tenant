import { describe, expect, it } from 'vitest';
import {
  extractConflictHunks,
  hasConflictMarkers,
  replaceConflictHunk,
} from './merge-conflict-hunks';

describe('merge-conflict-hunks', () => {
  it('detects conflict markers', () => {
    expect(hasConflictMarkers('clean\n')).toBe(false);
    expect(hasConflictMarkers('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n')).toBe(true);
  });

  it('extracts a single hunk', () => {
    const content = [
      'before',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> upstream/main',
      'after',
    ].join('\n');
    const hunks = extractConflictHunks(content);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toContain('ours');
    expect(hunks[0]).toContain('theirs');
  });

  it('replaces a hunk in place', () => {
    const hunk = ['<<<<<<< HEAD', 'old', '=======', 'x', '>>>>>>> u'].join('\n');
    const content = `line1\n${hunk}\nline2`;
    const resolved = 'merged line';
    expect(replaceConflictHunk(content, hunk, resolved)).toBe(
      `line1\n${resolved}\nline2`,
    );
  });
});
