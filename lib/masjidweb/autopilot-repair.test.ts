import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatAutopilotRepairMarkdown,
  runAutopilotRepair,
  type CommandResult,
  type RepairCommandRunner,
} from './autopilot-repair';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'autopilot-repair-'));
}

function makeRunner(conflictFiles: string[], commands: Record<string, CommandResult> = {}): RepairCommandRunner {
  return (command: string) => {
    if (command === 'git diff --name-only --diff-filter=U') {
      return { stdout: `${conflictFiles.join('\n')}\n`, exitCode: 0 };
    }
    if (command === 'git grep -l "^<<<<<<<" -- . ":(exclude)node_modules"') {
      return { stdout: '', exitCode: 1 };
    }
    return commands[command] ?? { stdout: '', exitCode: 0 };
  };
}

function conflict(...lines: string[]): string {
  return ['before', '<<<<<<< HEAD', ...lines, '=======', 'upstream', '>>>>>>> upstream/main', 'after'].join('\n');
}

describe('autopilot-repair', () => {
  it('regenerates package-lock.json from package.json without touching package.json', () => {
    const repoRoot = makeRepo();
    const packageJson = '{"name":"demo","version":"1.0.0"}\n';
    writeFileSync(join(repoRoot, 'package.json'), packageJson);
    writeFileSync(join(repoRoot, 'package-lock.json'), conflict('lock'));

    const runner = makeRunner(['package-lock.json'], {
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps': {
        stdout: '',
        exitCode: 0,
      },
      'npm run updates:autopilot-guard': { stdout: 'guard ok', exitCode: 0 },
    });

    const report = runAutopilotRepair({ repoRoot, runCommand: runner });

    expect(report.status).toBe('success');
    expect(report.repairedFiles).toEqual(['package-lock.json']);
    expect(report.actions[0]?.strategy).toBe('npm-lockfile-only');
    expect(report.guard?.passed).toBe(true);
  });

  it('blocks package-lock repair if npm mutates package.json', () => {
    const repoRoot = makeRepo();
    const packageJsonPath = join(repoRoot, 'package.json');
    writeFileSync(packageJsonPath, '{"name":"demo","version":"1.0.0"}\n');
    writeFileSync(join(repoRoot, 'package-lock.json'), conflict('lock'));

    const runner = makeRunner(['package-lock.json'], {
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps': {
        stdout: '',
        exitCode: 0,
      },
    });
    const mutatingRunner: RepairCommandRunner = (command) => {
      const result = runner(command);
      if (command.startsWith('npm install')) {
        writeFileSync(packageJsonPath, '{"name":"demo","version":"2.0.0"}\n');
      }
      return result;
    };

    const report = runAutopilotRepair({ repoRoot, runCommand: mutatingRunner });

    expect(report.status).toBe('blocked');
    expect(report.blockedFiles).toEqual(['package-lock.json']);
    expect(report.actions[0]?.summary).toContain('package.json');
  });

  it('blocks high-risk repository conflicts when tenant invariants cannot be proven', () => {
    const repoRoot = makeRepo();
    const filePath = 'lib/repositories/collectionItemRepository.ts';
    const fullPath = join(repoRoot, 'lib/repositories');
    writeFileSync(join(repoRoot, 'package.json'), '{}\n');
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(join(repoRoot, filePath), conflict('export async function getItems() { return []; }'));

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });

    expect(report.status).toBe('blocked');
    expect(report.blockedFiles).toEqual([filePath]);
    expect(report.actions[0]?.strategy).toBe('fail-closed-tenant-seam');
    expect(report.actions[0]?.details.join('\n')).toContain('conflict markers');
    expect(report.actions[0]?.details.join('\n')).toContain('tenant resolver present');
  });

  it('formats a human-readable report with actionable blocked details', () => {
    const repoRoot = makeRepo();
    const filePath = 'app/(builder)/ycode/api/publish/route.ts';
    mkdirSync(join(repoRoot, 'app/(builder)/ycode/api/publish'), { recursive: true });
    writeFileSync(join(repoRoot, filePath), conflict('export async function POST() {}'));

    const report = runAutopilotRepair({
      repoRoot,
      runCommand: makeRunner([filePath]),
      runGuard: false,
    });
    const markdown = formatAutopilotRepairMarkdown(report);

    expect(markdown).toContain('# Core Update Autopilot v2.1 repair report');
    expect(markdown).toContain('Status: blocked');
    expect(markdown).toContain(filePath);
    expect(markdown).toContain('publish tenant resolver present');
    expect(markdown).toContain('developer');
  });
});
