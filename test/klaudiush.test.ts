import assert from 'node:assert/strict';
import test from 'node:test';
import { klaudiushRules, splitKlaudiushMessage } from '../src/lib/klaudiush.ts';

const notice = [
  '**Notice:** PreToolUse:Bash says: ❌ GIT010: Git commit missing required flags: -s -S',
  'PreToolUse:Bash says: Fix: Add -sS flags to your command',
  'PreToolUse:Bash says: ❌ GIT020: Branch name must follow type/description format',
  'PreToolUse:Bash says: ❌ FILE011: Inline comments are not allowed',
  'PreToolUse:Bash says: ❌ GIT010: Git commit missing required flags: -s -S',
].join(' ');

void test('Klaudiush parser keeps unique rule codes and human reasons', () => {
  assert.deepEqual(klaudiushRules(notice), [
    { code: 'GIT010', reason: 'Git commit missing required flags: -s -S' },
    { code: 'GIT020', reason: 'Branch name must follow type/description format' },
    { code: 'FILE011', reason: 'Inline comments are not allowed' },
  ]);
  assert.deepEqual(klaudiushRules('❌ GIT010: Git commit missing required flags'), []);
});

void test('assistant notice leaves subsequent response visible', () => {
  assert.deepEqual(splitKlaudiushMessage(`${notice}\n\nAdjusting the setup.`), {
    rules: klaudiushRules(notice),
    notice,
    remainder: 'Adjusting the setup.',
  });
  assert.equal(splitKlaudiushMessage('Ordinary assistant response'), null);
});
