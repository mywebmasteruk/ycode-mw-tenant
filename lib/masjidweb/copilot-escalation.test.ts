import { describe, expect, it } from 'vitest';
import {
  COPILOT_ESCALATION_MARKER,
  buildCopilotEscalationPrompt,
} from './copilot-escalation';

describe('copilot escalation prompt', () => {
  it('includes an idempotent marker and hard tenant-isolation constraints', () => {
    const prompt = buildCopilotEscalationPrompt({
      prNumber: '19',
      blockedFiles: ['lib/repositories/pageRepository.ts'],
      repository: 'mywebmasteruk/ycode-mw-tenant',
      workflowRunUrl: 'https://github.com/mywebmasteruk/ycode-mw-tenant/actions/runs/123',
      reportJson: {
        status: 'blocked',
        humanSummary: 'Autopilot blocked this update to protect tenant data.',
        blockedFiles: ['lib/page-fetcher.ts'],
        actions: [
          {
            filePath: 'lib/page-fetcher.ts',
            outcome: 'blocked',
            reasonCategory: 'tenant-invariant-failed',
            nextAction: 'Restore missing tenant scope.',
          },
        ],
      },
    });

    expect(prompt).toContain(COPILOT_ESCALATION_MARKER);
    expect(prompt).toContain('Pull request: #19');
    expect(prompt).toContain('lib/page-fetcher.ts');
    expect(prompt).toContain('lib/repositories/pageRepository.ts');
    expect(prompt).toContain('Do **not** remove tenant filters');
    expect(prompt).toContain('Do **not** pass a tenant argument to `getSupabaseAdmin()`');
    expect(prompt).toContain('Preserve and use `resolveEffectiveTenantId`, `applyTenantEq`, and `runWithEffectiveTenantId`');
    expect(prompt).toContain('npm run updates:autopilot-guard');
    expect(prompt).toContain('bash scripts/check-tenant-isolation.sh');
    expect(prompt).toContain('npm run type-check');
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('**not** approval to merge');
  });

  it('falls back to a safe unknown file instruction when no blocked files are known', () => {
    const prompt = buildCopilotEscalationPrompt({
      prNumber: '21',
      blockedFiles: [],
    });

    expect(prompt).toContain('Unknown — inspect the Autopilot report and PR conflicts before changing code.');
    expect(prompt).toContain('No Autopilot report content was supplied');
  });
});
