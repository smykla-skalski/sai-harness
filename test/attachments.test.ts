import assert from 'node:assert/strict';
import test from 'node:test';
import { fileUri } from '../src/lib/attachments.ts';

await test('encode selected file paths as OpenCode URIs', () => {
  assert.equal(fileUri('/tmp/a #1.txt'), 'file:///tmp/a%20%231.txt');
  assert.equal(fileUri('C:\\Users\\me\\a b.txt'), 'file:///C:/Users/me/a%20b.txt');
});
