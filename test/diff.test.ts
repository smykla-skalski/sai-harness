import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileDiffInfo } from '@opencode/client';
import {
  annotateDiffs,
  parsePatch,
  patchUnavailableReason,
  repoPath,
  selectedDiffFile,
} from '../src/lib/diff.ts';
import type { Plan } from '../src/lib/plan.ts';

await test('repository path matching keeps same-name files distinct', () => {
  assert.equal(repoPath('/repo/src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(repoPath('src/./a.ts', '/repo'), 'src/a.ts');
  assert.equal(repoPath('/other/src/a.ts', '/repo'), null);
  assert.equal(repoPath('../other/a.ts', '/repo'), null);
  assert.equal(repoPath('C:\\Repo\\src\\a.ts', 'c:\\repo'), 'src/a.ts');
});

await test('annotate session diff with touched steps and drift', () => {
  const files: FileDiffInfo[] = ['src/a.ts', 'test/a.ts', 'src/b.ts'].map((file) => ({
    file,
    patch: '',
    additions: 1,
    deletions: 0,
    status: 'modified',
  }));
  const plan: Plan = {
    title: 'Plan',
    summary: 'Summary',
    sessionID: 'session',
    version: 1,
    state: 'executing',
    reviewReason: 'plan',
    createdAt: 1,
    outside: ['test/a.ts'],
    steps: [
      {
        id: 's1',
        title: 'Build',
        detail: 'Detail',
        files: ['src/a.ts'],
        risk: 'low',
        status: 'in_progress',
        origin: 'plan',
        touched: ['src/a.ts', 'src/b.ts'],
      },
    ],
  };
  const result = annotateDiffs(files, plan, '/repo');
  assert.deepEqual(result['src/a.ts'], {
    steps: ['Build'],
    drift: [],
    unattributed: false,
  });
  assert.deepEqual(result['test/a.ts'], {
    steps: [],
    drift: [],
    unattributed: true,
  });
  assert.deepEqual(result['src/b.ts'], {
    steps: ['Build'],
    drift: ['Build'],
    unattributed: false,
  });
  assert.equal(selectedDiffFile(files, '/repo/src/b.ts', '/repo'), 'src/b.ts');
  assert.equal(selectedDiffFile(files, 'src/b.ts', '/repo'), 'src/b.ts');
});

await test('parse only a selected readable patch and reject huge or empty patches', () => {
  assert.deepEqual(
    parsePatch('@@ -1 +1 @@\n-old\n+new\n context').map((line) => line.kind),
    ['hunk', 'deleted', 'added', 'context'],
  );
  assert.equal(parsePatch(''), null);
  assert.equal(parsePatch('x'.repeat(250_001)), null);
  assert.equal(parsePatch('Binary files a and b differ'), null);
  assert.equal(patchUnavailableReason('Binary files a and b differ'), 'binary');
});
