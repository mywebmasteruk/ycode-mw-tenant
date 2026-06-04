import { describe, expect, it } from 'vitest';
import { classifyConflictFile, summarizeConflictFiles } from './update-conflict-tiers';

describe('update-conflict-tiers', () => {
  it('classifies lockfiles and repositories', () => {
    expect(classifyConflictFile('package-lock.json')).toBe('lockfile');
    expect(classifyConflictFile('lib/repositories/pageRepository.ts')).toBe('tier2-repository');
    expect(classifyConflictFile('lib/masjidweb/apply-tenant-eq.ts')).toBe('fork-only');
    expect(classifyConflictFile('proxy.ts')).toBe('llm-required');
  });

  it('summarizes conflict lists by tier', () => {
    const summary = summarizeConflictFiles([
      'package-lock.json',
      'lib/repositories/assetRepository.ts',
      'proxy.ts',
    ]);
    expect(summary.lockfile).toEqual(['package-lock.json']);
    expect(summary['tier2-repository']).toEqual(['lib/repositories/assetRepository.ts']);
    expect(summary['llm-required']).toEqual(['proxy.ts']);
  });
});
