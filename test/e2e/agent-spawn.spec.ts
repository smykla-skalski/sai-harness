import { browser, $, expect } from '@wdio/globals';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';

type McpConfig = { command: string; args: string[]; env: Record<string, string> };
const mcpResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string() })),
});
const agentThread = z.object({ sessionId: z.string(), directory: z.string() });

function callMcp(config: McpConfig, sessionId: string, arguments_: Record<string, unknown>) {
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'agent_spawn',
        arguments: arguments_,
        _meta: { sessionID: sessionId },
      },
    })}\n`,
  );
  return new Promise<z.infer<typeof mcpResult>>((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`MCP process exited ${code}: ${stderr}; stdout=${stdout}`));
        return;
      }
      try {
        const response: unknown = JSON.parse(stdout.trim());
        resolve(z.object({ result: mcpResult }).parse(response).result);
      } catch (error) {
        reject(new Error(`Invalid MCP response: ${stdout}; stderr=${stderr}`, { cause: error }));
      }
    });
  });
}

describe('provider selected agent spawn', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-spawn-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'seed',
    ]);
  });
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('selects Codex in a new worktree and asks before sharing an existing one', async () => {
    const path = realpathSync(repository);
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.setItem('sai-notifications-enabled', 'false');
    }, path);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await $('.agent-launches button').click();
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Boolean(document.querySelector('.agent-composer textarea:not([disabled])')),
        ),
      { timeout: 15_000 },
    );
    await $('.agent-composer textarea').setValue('Clipboard fixture source');
    await $('.agent-actions button').click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const saved: unknown = JSON.parse(localStorage.getItem('sail-agent-threads') ?? '[]');
          return Array.isArray(saved) && saved.length > 0;
        }),
      { timeout: 15_000 },
    );
    const saved = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const sessionId = z.array(agentThread).parse(JSON.parse(saved ?? '[]'))[0].sessionId;

    await $('.agent-launches button:nth-child(2)').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Clipboard fixture authenticate Codex');
    await $('.agent-actions button').click();
    await expect($('.agent-auth button')).toBeDisplayed();
    await $('.agent-auth button').click();
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Clipboard received:'),
    );

    const config = await browser.tauri.execute(
      async ({ core }, directory) => core.invoke<McpConfig>('browser_mcp_config', { directory }),
      path,
    );
    const invalid = await callMcp(config, sessionId, {
      provider: 'other',
      prompt: 'Clipboard fixture invalid',
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain('Choose Claude, Codex, or OpenCode');
    const spawnNew = callMcp(config, sessionId, {
      provider: 'codex',
      prompt: 'Clipboard fixture delegate',
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await expect($('.worktree-approval-dialog')).toHaveText(expect.stringContaining('codex'));
    await $('.worktree-approval-actions button:last-child').click();
    const newResult = await spawnNew;
    expect(newResult.isError).not.toBe(true);
    const started = z
      .object({
        status: z.string(),
        threadId: z.string(),
        worktreeId: z.string(),
        path: z.string(),
      })
      .parse(JSON.parse(newResult.content[0].text));
    expect(started.status).toBe('started');
    expect(started.threadId).toMatch(/^acp:codex:/);
    expect(started.worktreeId).toBe(started.path);
    expect(existsSync(started.path)).toBe(true);

    const spawnShared = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture shared',
      target: { kind: 'existing', path },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await expect($('.worktree-approval-dialog')).toHaveText(
      expect.stringContaining('share this worktree’s files'),
    );
    await $('.worktree-approval-actions button:first-child').click();
    const denied = await spawnShared;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('User declined');

    const approvedShared = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture approved shared',
      target: { kind: 'existing', path },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await $('.worktree-approval-actions button:last-child').click();
    const sharedResult = await approvedShared;
    expect(sharedResult.isError).not.toBe(true);
    const shared = z
      .object({
        status: z.string(),
        threadId: z.string(),
        worktreeId: z.string(),
        path: z.string(),
      })
      .parse(JSON.parse(sharedResult.content[0].text));
    expect(shared.status).toBe('started');
    expect(shared.threadId).toMatch(/^acp:claude:/);
    expect(shared.worktreeId).toBe(path);
    expect(shared.path).toBe(path);

    let openCodeFinished = false;
    const spawnOpenCode = callMcp(config, sessionId, {
      provider: 'opencode',
      prompt: 'Clipboard fixture OpenCode',
      target: { kind: 'existing', path },
    }).then((result) => {
      openCodeFinished = true;
      return result;
    });
    await browser.waitUntil(
      async () => openCodeFinished || (await $('.worktree-approval-dialog').isDisplayed()),
      { timeout: 15_000 },
    );
    if (await $('.worktree-approval-dialog').isDisplayed()) {
      await $('.worktree-approval-actions button:last-child').click();
    }
    const openCodeResult = await spawnOpenCode;
    if (openCodeResult.isError) {
      expect(openCodeResult.content[0].text).toContain(
        'Complete OpenCode setup in the target worktree before spawning',
      );
      console.log(
        `OpenCode spawn unavailable in isolated fixture: ${openCodeResult.content[0].text}`,
      );
    } else {
      const openCode = z
        .object({ status: z.string(), threadId: z.string(), worktreeId: z.string() })
        .parse(JSON.parse(openCodeResult.content[0].text));
      expect(openCode.status).toBe('started');
      expect(openCode.threadId).toMatch(/^opencode:/);
      expect(openCode.worktreeId).toBe(path);
    }

    await browser.refresh();
    const rawRestored = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const restored = z.array(agentThread).parse(JSON.parse(rawRestored ?? '[]'));
    expect(
      restored.some(
        (thread) =>
          `acp:codex:${thread.sessionId}` === started.threadId && thread.directory === started.path,
      ),
    ).toBe(true);
  });

  it('reports setup failure without creating an agent thread', async () => {
    const path = realpathSync(repository);
    mkdirSync(join(repository, '.sail'), { recursive: true });
    writeFileSync(join(repository, '.sail', 'worktree.json'), JSON.stringify({ setup: 'exit 7' }));
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'add',
      '.sail/worktree.json',
    ]);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'failing setup',
    ]);
    const saved = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const sessionId = z
      .array(agentThread)
      .parse(JSON.parse(saved ?? '[]'))
      .find((thread) => thread.directory === path)?.sessionId;
    if (!sessionId) throw new Error('Source thread was not restored');
    const config = await browser.tauri.execute(
      async ({ core }, directory) => core.invoke<McpConfig>('browser_mcp_config', { directory }),
      path,
    );
    const spawnNew = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture no launch',
      target: { kind: 'new', name: 'failing-setup' },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await $('.worktree-approval-actions button:last-child').click();
    const result = await spawnNew;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Worktree setup exited with code 7');
    const threadsRaw = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const threads = z.array(agentThread).parse(JSON.parse(threadsRaw ?? '[]'));
    expect(threads.some((thread) => basename(thread.directory) === 'failing-setup')).toBe(false);
    const catalogRaw = await browser.execute(() => localStorage.getItem('sai-project-catalog'));
    const catalog = z
      .object({ worktrees: z.record(z.string(), z.array(z.object({ path: z.string() }))) })
      .parse(JSON.parse(catalogRaw ?? '{}'));
    const failedPath = catalog.worktrees[path].find(
      (item) => basename(item.path) === 'failing-setup',
    )?.path;
    if (!failedPath) throw new Error('Failed setup worktree was not saved');
    const retry = await callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture should not start',
      target: { kind: 'existing', path: failedPath },
    });
    expect(retry.isError).toBe(true);
    expect(retry.content[0].text).toContain('Complete worktree setup');
  });
});
