import { describe, expect, it } from 'vitest';
import {
  classifyUpdateRisk,
  formatUpdateSafetyReport,
} from './update-safety-check';

describe('classifyUpdateRisk', () => {
  it('marks tenant-sensitive core files as high risk', () => {
    const result = classifyUpdateRisk([
      'app/(builder)/ycode/api/publish/route.ts',
      'lib/repositories/pageRepository.ts',
      'components/ui/button.tsx',
    ]);

    expect(result.level).toBe('high');
    expect(result.highRiskFiles).toEqual([
      'app/(builder)/ycode/api/publish/route.ts',
      'lib/repositories/pageRepository.ts',
    ]);
    expect(result.safeFiles).toEqual(['components/ui/button.tsx']);
  });

  it('marks updates with conflicts as blocked', () => {
    const result = classifyUpdateRisk(
      ['components/ui/button.tsx'],
      ['lib/repositories/pageRepository.ts']
    );

    expect(result.level).toBe('blocked');
    expect(result.conflictFiles).toEqual(['lib/repositories/pageRepository.ts']);
    expect(result.needsDeveloperReview).toBe(true);
  });

  it('formats a plain-English report for non-technical review', () => {
    const result = classifyUpdateRisk(
      ['app/(site)/page.tsx'],
      ['app/(builder)/ycode/api/publish/route.ts']
    );

    expect(formatUpdateSafetyReport(result)).toContain('Status: blocked');
    expect(formatUpdateSafetyReport(result)).toContain('This update has merge conflicts');
    expect(formatUpdateSafetyReport(result)).toContain('app/(builder)/ycode/api/publish/route.ts');
  });
});
