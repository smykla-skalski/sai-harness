import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFileLinks } from '../src/lib/terminal-links.ts';

void test('terminal file links include relative, absolute, and Windows paths', () => {
  assert.deepEqual(terminalFileLinks('src/App.svelte:23 /tmp/a.rs:4 C:\\repo\\main.ts:9:2'), [
    { path: 'src/App.svelte', line: 23, text: 'src/App.svelte:23', start: 1 },
    { path: '/tmp/a.rs', line: 4, text: '/tmp/a.rs:4', start: 19 },
    { path: 'C:\\repo\\main.ts', line: 9, text: 'C:\\repo\\main.ts:9:2', start: 31 },
  ]);
  assert.deepEqual(terminalFileLinks('https://example.com/a.ts:2'), []);
});

void test('terminal links preserve spaced, quoted, escaped, and extensionless paths', () => {
  assert.deepEqual(terminalFileLinks('/tmp/my file.ts:2 Makefile:12'), [
    { path: '/tmp/my file.ts', line: 2, text: '/tmp/my file.ts:2', start: 1 },
    { path: 'Makefile', line: 12, text: 'Makefile:12', start: 19 },
  ]);
  assert.deepEqual(terminalFileLinks('"my file.ts":7 my\\ file.ts:3'), [
    { path: 'my file.ts', line: 7, text: '"my file.ts":7', start: 1 },
    { path: 'my file.ts', line: 3, text: 'my\\ file.ts:3', start: 16 },
  ]);
});
