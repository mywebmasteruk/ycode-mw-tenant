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
    expect(result.status).toBe('review_required');
    expect(result.riskLevel).toBe('HIGH');
    expect(result.highRiskFiles).toEqual([
      'app/(builder)/ycode/api/publish/route.ts',
      'lib/repositories/pageRepository.ts',
    ]);
    expect(result.mediumRiskFiles).toEqual(['components/ui/button.tsx']);
  });

  it('blocks tenant-sensitive conflicts to protect tenant data', () => {
    const result = classifyUpdateRisk(
      ['components/ui/button.tsx'],
      ['lib/repositories/pageRepository.ts'],
    );

    expect(result.level).toBe('blocked');
    expect(result.status).toBe('blocked');
    expect(result.riskLevel).toBe('HIGH');
    expect(result.conflictFiles).toEqual(['lib/repositories/pageRepository.ts']);
    expect(result.needsDeveloperReview).toBe(true);
    expect(result.blockedReasons.join('\n')).toContain('protect tenant data');
    expect(result.nextActions.join('\n')).toContain('Developer required');
  });

  it('treats package-lock conflicts as mechanically repairable medium risk', () => {
    const result = classifyUpdateRisk(['package-lock.json'], ['package-lock.json']);

    expect(result.status).toBe('blocked');
    expect(result.riskLevel).toBe('MEDIUM');
    expect(result.mediumRiskFiles).toEqual(['package-lock.json']);
    expect(result.classifications[0]?.autopilotAction).toContain('Regenerate package-lock.json');
  });

  it('formats a plain-English report for non-technical review', () => {
    const result = classifyUpdateRisk(
      ['app/(site)/page.tsx'],
      ['app/(builder)/ycode/api/publish/route.ts'],
    );
    const report = formatUpdateSafetyReport(result);

    expect(report).toContain('Status: blocked');
    expect(report).toContain('Risk: HIGH');
    expect(report).toContain('Autopilot blocked this update to protect tenant data');
    expect(report).toContain('app/(builder)/ycode/api/publish/route.ts');
  });
});
