import assert from 'node:assert/strict';
import test from 'node:test';
import { toolCommand, toolInput } from '../src/lib/tool-display.ts';

void test('tool display extracts structured shell commands', () => {
  assert.equal(toolCommand({ command: 'npm test', timeout: 120000 }), 'npm test');
  assert.equal(toolCommand('{"command":"git status"}'), 'git status');
  assert.equal(toolCommand('{"command":'), null);
  assert.equal(toolCommand({ command: 42 }), null);
  assert.equal(toolCommand({ file: 'src/App.svelte' }), null);
});

void test('tool display formats input without changing plain text', () => {
  assert.equal(toolInput({ command: 'npm test' }), '{\n  "command": "npm test"\n}');
  assert.equal(toolInput('{"command":"npm test"}'), '{\n  "command": "npm test"\n}');
  assert.equal(toolInput('partial {'), 'partial {');
});
