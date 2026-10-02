import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingSkills, promptSkill, skillQuery } from '../src/lib/skills.ts';

const skills = [
  { id: 'one', name: 'ship-issue', description: 'Ship a GitHub issue' },
  { id: 'two', name: 'review', description: 'Review code' },
];

void test('slash matches names and closes after arguments begin', () => {
  assert.equal(skillQuery('/'), '');
  assert.deepEqual(matchingSkills(skills, '/SHIP'), [skills[0]]);
  assert.deepEqual(matchingSkills(skills, '/ship-issue '), []);
  assert.deepEqual(matchingSkills(skills, 'Please /ship'), []);
});

void test('a selected skill resolves from a prompt with arguments', () => {
  assert.equal(promptSkill(skills, '/ship-issue https://example.com')?.id, 'one');
  assert.equal(promptSkill(skills, '/ship-issue')?.id, 'one');
  assert.equal(promptSkill(skills, '/ship-issues'), undefined);
});
