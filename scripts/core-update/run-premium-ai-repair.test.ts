import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PremiumAiResolvedFile } from '../../lib/masjidweb/premium-ai-patch';
import { createCheckpointForAppliedFiles, repairFilesOneAtATime, requiredOutputSchema } from './run-premium-ai-repair';

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

  it('retries invalid JSON once with strict JSON repair', async () => {
    const attempts: string[] = [];

    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async (filePath, attempt, promptOverride) => {
        attempts.push(`${attempt}:${promptOverride?.includes('Retry once') ? 'strict' : 'normal'}`);
        if (attempt === 'initial') {
          return { reply: '{ invalid json', model: 'test/model', finishReason: 'stop' };
        }
        return {
          reply: JSON.stringify({
            summary: 'Strict JSON retry resolved file.',
            files: [{ filePath, verdict: 'safe_candidate', summary: 'Safe', safetyConcerns: [], unifiedDiff: null }],
            resolvedFiles: [{ filePath, content: 'export const jsonRetryResolved = true;\n' }],
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

    expect(attempts).toEqual(['initial:normal', 'json_repair:strict']);
    expect(result.appliedFiles).toEqual(['lib/a.ts']);
    expect(result.results).toMatchObject([{ filePath: 'lib/a.ts', status: 'applied', applied: true, retryUsed: true }]);
  });

  it('decodes a base64 resolved file and applies the exact content', async () => {
    let appliedContent = '';
    // Content that would break a raw JSON string (newlines + quotes + tab) but is
    // safe inside base64 — the mandated form.
    const finalSource = 'export const a = 1;\nconst s = "with \\"quotes\\" and a tab\there";\n';
    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async (filePath) => ({
        reply: JSON.stringify({
          summary: 'Resolved via base64.',
          files: [{ filePath, verdict: 'safe_candidate', summary: 'Safe', safetyConcerns: [], content: null, unifiedDiff: null }],
          resolvedFiles: [{ filePath, contentBase64: Buffer.from(finalSource, 'utf8').toString('base64') }],
          patches: [],
          nextActions: [],
        }),
        model: 'test/model',
        finishReason: 'stop',
      }),
      applyFile: (file: PremiumAiResolvedFile) => {
        appliedContent = file.content;
        return file.filePath;
      },
      validateFile: () => undefined,
    });

    expect(result.appliedFiles).toEqual(['lib/a.ts']);
    expect(appliedContent).toBe(finalSource);
  });

  it('recovers from invalid JSON when the retry returns base64 content', async () => {
    let appliedContent = '';
    const resolved = 'export const recovered = true;\n// a line with "quotes"\n';
    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async (filePath, attempt) => {
        if (attempt === 'initial') {
          // Real failure mode: a big raw content string with a literal newline → invalid JSON.
          return { reply: '{"resolvedFiles":[{"filePath":"lib/a.ts","content":"line1\nline2"}]}', model: 'test/model', finishReason: 'stop' };
        }
        return {
          reply: JSON.stringify({
            summary: 'Retry via base64.',
            files: [{ filePath, verdict: 'safe_candidate', summary: 'Safe', safetyConcerns: [], content: null, unifiedDiff: null }],
            resolvedFiles: [{ filePath, contentBase64: Buffer.from(resolved, 'utf8').toString('base64') }],
            patches: [],
            nextActions: [],
          }),
          model: 'test/model',
          finishReason: 'stop',
        };
      },
      applyFile: (file: PremiumAiResolvedFile) => {
        appliedContent = file.content;
        return file.filePath;
      },
      validateFile: () => undefined,
    });

    expect(result.appliedFiles).toEqual(['lib/a.ts']);
    expect(appliedContent).toBe(resolved);
    expect(result.results[0]).toMatchObject({ status: 'applied', applied: true, retryUsed: true });
  });

  it('mandates base64 for resolved file content in the output schema', () => {
    const schema = requiredOutputSchema();
    expect(schema).toContain('"resolvedFiles": [{ "filePath": string, "contentBase64": string }]');
    expect(schema).not.toContain('"resolvedFiles": [{ "filePath": string, "content": string }]');
  });

  it('persists validated partial repairs as a patch artifact', () => {
    const previousCwd = process.cwd();
    const tempRoot = mkdtempSync(join(tmpdir(), 'premium-ai-checkpoint-test-'));
    mkdirSync(join(tempRoot, 'lib'), { recursive: true });
    writeFileSync(join(tempRoot, 'lib/a.ts'), 'export const value = false;\n');
    writeFileSync(join(tempRoot, 'lib/b.ts'), 'export const unresolved = true;\n');
    execSync('git init', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git config user.email test@example.com', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git config user.name Test', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git add . && git commit -m initial', { cwd: tempRoot, stdio: 'ignore' });
    writeFileSync(join(tempRoot, 'lib/a.ts'), 'export const value = true;\n');
    writeFileSync(join(tempRoot, 'lib/b.ts'), '<<<<<<< HEAD\nexport const unresolved = true;\n=======\nexport const unresolved = false;\n>>>>>>> upstream\n');

    const patchPath = join(tempRoot, 'checkpoint.patch');
    const previousPatchPath = process.env.PREMIUM_AI_REPAIR_PATCH_PATH;
    const previousCheckpointDir = process.env.PREMIUM_AI_REPAIR_CHECKPOINT_DIR;
    process.env.PREMIUM_AI_REPAIR_PATCH_PATH = patchPath;
    process.env.PREMIUM_AI_REPAIR_CHECKPOINT_DIR = join(tempRoot, 'checkpoints');
    process.chdir(tempRoot);
    const checkpoint = createCheckpointForAppliedFiles(['lib/a.ts'], ['lib/b.ts'], tempRoot);
    process.chdir(previousCwd);
    if (previousPatchPath === undefined) {
      delete process.env.PREMIUM_AI_REPAIR_PATCH_PATH;
    } else {
      process.env.PREMIUM_AI_REPAIR_PATCH_PATH = previousPatchPath;
    }
    if (previousCheckpointDir === undefined) {
      delete process.env.PREMIUM_AI_REPAIR_CHECKPOINT_DIR;
    } else {
      process.env.PREMIUM_AI_REPAIR_CHECKPOINT_DIR = previousCheckpointDir;
    }

    expect(checkpoint.persisted).toBe(true);
    expect(readFileSync(patchPath, 'utf8')).toContain('export const value = true;');
    expect(readFileSync(join(tempRoot, 'lib/b.ts'), 'utf8')).toBe('export const unresolved = true;\n');
    expect(execSync('git diff --cached --name-only', { cwd: tempRoot, encoding: 'utf8' }).trim()).toBe('lib/a.ts');
  });

  it('stops after repeated truncation unless hunk fallback is enabled', async () => {
    const attempts: string[] = [];
    const fileContent = [
      'export function value() {',
      '<<<<<<< HEAD',
      '  return "ours";',
      '=======',
      '  return "theirs";',
      '>>>>>>> upstream/main',
      '}',
      '',
    ].join('\n');

    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async (_filePath, attempt) => {
        attempts.push(attempt);
        throw new Error('OpenRouter response was truncated (finish_reason=length).');
      },
      applyFile: (file: PremiumAiResolvedFile) => file.filePath,
      validateFile: () => undefined,
      readFile: () => fileContent,
    });

    expect(attempts).toEqual(['initial', 'truncation_retry']);
    expect(result.appliedFiles).toEqual([]);
    expect(result.results).toMatchObject([{ filePath: 'lib/a.ts', status: 'model_truncated', applied: false, retryUsed: true }]);
    expect(result.results[0]?.summary).toContain('Hunk fallback is disabled');
  });

  it('falls back to hunk-level repair after repeated truncation when enabled', async () => {
    const attempts: string[] = [];
    let fileContent = [
      'export function value() {',
      '<<<<<<< HEAD',
      '  return "ours";',
      '=======',
      '  return "theirs";',
      '>>>>>>> upstream/main',
      '}',
      '',
    ].join('\n');

    const result = await repairFilesOneAtATime({
      targetFiles: ['lib/a.ts'],
      blockedFiles: ['lib/a.ts'],
      requestFile: async (filePath, attempt, promptOverride) => {
        attempts.push(attempt);
        if (attempt === 'initial' || attempt === 'truncation_retry') {
          throw new Error('OpenRouter response was truncated (finish_reason=length).');
        }
        if (attempt === 'hunk' && promptOverride?.includes('resolvedHunk')) {
          return {
            reply: JSON.stringify({
              summary: 'Resolved one hunk safely.',
              verdict: 'safe_candidate',
              safetyConcerns: [],
              resolvedHunk: '  return "ours";',
            }),
            model: 'test/model',
            finishReason: 'stop',
          };
        }
        return {
          reply: JSON.stringify({
            summary: 'Resolved by hunk fallback.',
            files: [{ filePath, verdict: 'safe_candidate', summary: 'Safe', safetyConcerns: [], unifiedDiff: null }],
            resolvedFiles: [{ filePath, content: 'export function value() {\n  return "ours";\n}\n' }],
            patches: [],
            nextActions: [],
          }),
          model: 'test/model',
          finishReason: 'stop',
        };
      },
      applyFile: (file: PremiumAiResolvedFile) => {
        expect(file.content).not.toContain('<<<<<<<');
        fileContent = file.content;
        return file.filePath;
      },
      validateFile: () => undefined,
      readFile: () => fileContent,
      enableHunkFallback: true,
    });

    expect(fileContent).not.toContain('<<<<<<<');
    expect(attempts).toEqual(['initial', 'truncation_retry', 'hunk']);
    expect(result.appliedFiles).toEqual(['lib/a.ts']);
    expect(result.results).toMatchObject([{ filePath: 'lib/a.ts', status: 'hunk_fallback_applied', applied: true, retryUsed: true }]);
  });
});
