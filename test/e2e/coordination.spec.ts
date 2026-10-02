import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent coordination bridge', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-coordination-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('rejects a saved ACP source session that is no longer running', async () => {
    const path = realpathSync(repository);
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.setItem(
        'sail-agent-threads',
        JSON.stringify([
          {
            agent: 'claude',
            directory,
            sessionId: 'test-stale-session',
            title: 'Stale ACP source',
            updated: Date.now(),
          },
        ]),
      );
    }, path);
    await browser.refresh();
    const config = await browser.tauri.execute(
      async ({ core }, directory) =>
        core.invoke<{ command: string; args: string[]; env: Record<string, string> }>(
          'browser_mcp_config',
          { directory },
        ),
      path,
    );
    const response = execFileSync(config.command, config.args, {
      env: { ...process.env, ...config.env },
      input: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'worktree_list',
          arguments: {},
          _meta: { sessionID: 'test-stale-session' },
        },
      })}\n`,
      timeout: 30_000,
      encoding: 'utf8',
    });
    const result = JSON.parse(response.trim());
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('The source agent session is unavailable.');
  });
});
