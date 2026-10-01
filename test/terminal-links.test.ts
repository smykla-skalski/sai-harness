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
