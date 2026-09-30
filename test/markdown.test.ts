import assert from 'node:assert/strict';
import test from 'node:test';
import { safeMarkdownHref } from '../src/lib/markdown.ts';

await test('only navigates to safe Markdown links', () => {
  assert.equal(safeMarkdownHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeMarkdownHref('mailto:user@example.com'), 'mailto:user@example.com');
  assert.equal(safeMarkdownHref('#section'), '#section');
  assert.equal(safeMarkdownHref('javascript:alert(1)'), null);
  assert.equal(safeMarkdownHref('data:text/html,<script>bad</script>'), null);
  assert.equal(safeMarkdownHref('//example.com'), null);
});
