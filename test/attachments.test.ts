import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipboardFiles,
  fileUri,
  insertClipboardText,
  MAX_CLIPBOARD_FILE_SIZE,
  stageClipboardFile,
} from '../src/lib/attachments.ts';

await test('encode selected file paths as OpenCode URIs', () => {
  assert.equal(fileUri('/tmp/a #1.txt'), 'file:///tmp/a%20%231.txt');
  assert.equal(fileUri('C:\\Users\\me\\a b.txt'), 'file:///C:/Users/me/a%20b.txt');
});

await test('clipboard files are distinct from ordinary text paste', () => {
  const file = new File(['hello'], 'note.txt');
  assert.deepEqual(clipboardFiles({ clipboardData: { files: [file] } }), [file]);
  assert.deepEqual(clipboardFiles({ clipboardData: { files: [] } }), []);
  assert.deepEqual(clipboardFiles({}), []);
});

await test('mixed clipboard paste preserves text at the caret', () => {
  assert.equal(insertClipboardText('before after', 'and ', 7, 7), 'before and after');
  assert.equal(insertClipboardText('before after', 'new', 7, 12), 'before new');
});

await test('reject oversized clipboard files before crossing the Tauri bridge', async () => {
  const file = new File([new Uint8Array(MAX_CLIPBOARD_FILE_SIZE + 1)], 'large.bin');
  await assert.rejects(stageClipboardFile(file), /20 MiB/);
});
