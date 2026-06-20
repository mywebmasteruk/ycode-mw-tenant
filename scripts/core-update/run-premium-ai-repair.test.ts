import { describe, expect, it } from 'vitest';
import type { PremiumAiResolvedFile } from '../../lib/masjidweb/premium-ai-patch';
import { repairFilesOneAtATime } from './run-premium-ai-repair';

describe('Premium AI per-file repair aggregation', () => {
  it('applies a valid single-file response', async () => {
    const applied: string[] = [];

    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async (filePath) => ({
        reply: JSON.stringify({
          summary: 'Resolved one file safely.',
          files: [{ filePath, verdict: 'safe_candidate', summary: 'Safe', safetyConcerns: [], unifiedDiff: null }],
          resolvedFiles: [{ filePath, content: 'export const resolvedValue = true;\n' }],
          patches: [],
          nextActions: [],
        }),
        model: 'test/model',
        finishReason: 'stop',
      }),
      applyFile: (file: PremiumAiResolvedFile) => {
        applied.push(file.filePath);
        return file.filePath;
      },
      validateFile: () => undefined,
    });

    expect(applied).toEqual(['lib/a.ts']);
    expect(result.appliedFiles).toEqual(['lib/a.ts']);
    expect(result.results).toMatchObject([{ filePath: 'lib/a.ts', status: 'applied', applied: true }]);
  });

  it('records one file truncation while continuing to other files', async () => {
    const attempts: string[] = [];

    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts', 'lib/b.ts'],
      blockedFiles: ['lib/a.ts', 'lib/b.ts'],
      requestFile: async (filePath, attempt) => {
        attempts.push(`${filePath}:${attempt}`);
        if (filePath === 'lib/a.ts') {
          throw new Error('OpenRouter response was truncated (finish_reason=length).');
        }
        return {
          reply: JSON.stringify({
            summary: 'Resolved b.',
            files: [{ filePath, verdict: 'safe_candidate', summary: 'Safe', safetyConcerns: [], unifiedDiff: null }],
            resolvedFiles: [{ filePath, content: 'export const bResolved = true;\n' }],
            patches: [],
            nextActions: [],
          }),
          model: 'test/model',
          finishReason: 'stop',
        };
      },
      applyFile: (file: PremiumAiResolvedFile) => file.filePath,
      validateFile: () => undefined,
    });

    expect(attempts).toEqual(['lib/a.ts:initial', 'lib/a.ts:truncation_retry', 'lib/b.ts:initial']);
    expect(result.appliedFiles).toEqual(['lib/b.ts']);
    expect(result.results).toMatchObject([
      { filePath: 'lib/a.ts', status: 'model_truncated', applied: false, retryUsed: true },
      { filePath: 'lib/b.ts', status: 'applied', applied: true, retryUsed: false },
    ]);
  });

  it('records per-file blocked failure in the aggregate report', async () => {
    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async (filePath) => ({
        reply: JSON.stringify({
          summary: 'Unsafe to repair.',
          files: [{ filePath, verdict: 'blocked', summary: 'Needs human review', safetyConcerns: ['tenant scope unclear'], unifiedDiff: null }],
          resolvedFiles: [],
          patches: [],
          nextActions: ['Repair manually.'],
        }),
        model: 'test/model',
        finishReason: 'stop',
      }),
      applyFile: (file: PremiumAiResolvedFile) => file.filePath,
      validateFile: () => undefined,
    });

    expect(result.appliedFiles).toEqual([]);
    expect(result.results).toMatchObject([
      {
        filePath: 'lib/a.ts',
        status: 'blocked',
        applied: false,
        safetyConcerns: ['tenant scope unclear'],
      },
    ]);
  });

  it('handles invalid JSON cleanly for one file', async () => {
    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async () => ({ reply: '{ invalid json', model: 'test/model', finishReason: 'stop' }),
      applyFile: (file: PremiumAiResolvedFile) => file.filePath,
      validateFile: () => undefined,
    });

    expect(result.appliedFiles).toEqual([]);
    expect(result.results).toMatchObject([{ filePath: 'lib/a.ts', status: 'invalid_json', applied: false }]);
    expect(result.results[0]?.error).toContain('No JSON object found');
  });
});
