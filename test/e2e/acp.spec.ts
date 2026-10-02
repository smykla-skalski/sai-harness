import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ACP agent threads', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-acp-e2e-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('hosts Claude and Codex conversations, approvals, and restored history in Sail', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    try {
      await expect($('.agent-launches')).toHaveText(expect.stringContaining('Claude'));
    } catch (cause) {
      console.error('ACP discovery diagnostic', {
        agents: await browser.tauri.execute(async ({ core }) => core.invoke('acp_agents')),
        sidebar: await $('.sidebar').getText(),
        page: await browser.execute(() => document.body.innerText.slice(0, 2000)),
      });
      throw cause;
    }
    await $('.agent-launches button').click();
    await expect($('.workspace .chat-area .agent-workspace')).toBeDisplayed();
    try {
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    } catch (cause) {
      console.error('ACP connection diagnostic', {
        agents: await browser.tauri.execute(async ({ core }) => core.invoke('acp_agents')),
        workspace: await $('.agent-workspace').getText(),
        settings: await $('.topbar-actions').getText(),
      });
      throw cause;
    }
    await expect($('.agent-picker-controls')).toHaveText(expect.stringContaining('Model'));
    await expect($('.agent-picker-controls')).toHaveText(expect.stringContaining('Effort'));
    await $('.agent-composer textarea').setValue('/model');
    await browser.keys('Enter');
    await expect($('.option-menu[role="listbox"]')).toBeDisplayed();
    await expect($('.option-menu button[role="option"]:nth-child(2)')).toBeDisplayed();
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label="Choose model"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    await $('.option-trigger[aria-label="Choose model"]').click();
    await $('.option-menu button[role="option"]:nth-child(3)').click();
    await $('.agent-composer textarea').setValue('Keep this draft');
    await $('.agent-actions button').click();
    await expect($('.agent-error')).toHaveText(expect.stringContaining('Model change rejected'));
    await expect($('.agent-composer textarea')).toHaveValue('Keep this draft');
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Keep this draft'),
    );
    await $('.option-trigger[aria-label="Choose model"]').click();
    await $('.option-menu button[role="option"]:nth-child(2)').click();
    await $('.agent-composer textarea').setValue('');
    await $('.agent-composer textarea').setValue('/effort');
    await browser.keys('Enter');
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label="Choose effort"]')).toHaveText(
      expect.stringContaining('High'),
    );
    await $('.agent-composer textarea').setValue('Do a small thing');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toHaveText(expect.stringContaining('Run test action'));
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );
    await expect($('.option-trigger[aria-label="Choose model"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    writeFileSync(join(repository, 'agent-change.txt'), 'Changed by agent\n');
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await expect($('.workspace .side-area')).toHaveText(
      expect.stringContaining('agent-change.txt'),
    );
    await $('.workspace .side-area button[aria-label="Close Changes"]').click();

    await $('.agent-launches button:nth-child(2)').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Codex'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Try Codex');
    await $('.agent-actions button').click();
    await expect($('.agent-auth')).toHaveText(expect.stringContaining('Sign in with ChatGPT'));
    await expect($('.agent-composer textarea')).toHaveValue('Try Codex');
    await $('.agent-auth button').click();
    await $('.agent-actions button').click();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Done: Try Codex'));
    await $('.agent-picker-controls .option-trigger[aria-label="Choose effort"]').click();
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label="Choose effort"]')).toHaveText(
      expect.stringContaining('High'),
    );

    try {
      await $('.session-row .session-item[title="Do a small thing"]').click();
    } catch (cause) {
      console.error('ACP thread list diagnostic', {
        sidebar: await $('.sidebar').getText(),
        threads: await browser.execute(() => localStorage.getItem('sail-agent-threads')),
      });
      throw cause;
    }
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );
    await browser.refresh();
    try {
      await $('.session-row .session-item[title="Do a small thing"]').click();
    } catch (cause) {
      console.error('ACP reload diagnostic', {
        sidebar: await $('.sidebar').getText(),
        threads: await browser.execute(() => localStorage.getItem('sail-agent-threads')),
        directory: await browser.execute(() => localStorage.getItem('sai-directory')),
        origin: await browser.execute(() => location.origin),
        keys: await browser.execute(() => Object.keys(localStorage)),
      });
      throw cause;
    }
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button').click();
    await expect($('.session-row .session-item[title="Delayed approval"]')).toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-launches button:nth-child(2)').click();
    await expect($('.session-row .session-item[title="Delayed approval"]')).toHaveText(
      expect.stringMatching(/Running|Waiting for input/),
    );
    await browser.pause(1800);
    await $('.session-row .session-item[title="Delayed approval"]').click();
    await expect($('.agent-permission')).toHaveText(expect.stringContaining('Run test action'));
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Delayed approval'),
    );

    await $('.agent-composer textarea').setValue('Escape stop');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await browser.keys('Escape');
    await expect($('.agent-permission')).not.toBeDisplayed();
    await expect($('.agent-busy')).not.toBeDisplayed();
    await expect($('.agent-tool')).toHaveText(expect.stringContaining('cancelled'));

    await $('.agent-composer textarea').setValue('Slow cancel');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.agent-tool')).toHaveText(expect.stringContaining('stopping'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.session-row .session-item[title="Delayed approval"]')).toHaveText(
      expect.stringContaining('working'),
    );
    await expect($('.agent-tool')).toHaveText(expect.stringContaining('cancelled'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));

    await $('.agent-composer textarea').setValue('Long answer');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    const beforeReply = await browser.execute(
      () => document.querySelector('.agent-conversation')?.scrollTop ?? -1,
    );
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Answer line 99'));
    expect(
      await browser.execute(() => {
        const conversation = document.querySelector('.agent-conversation');
        return conversation ? conversation.scrollHeight > conversation.clientHeight : false;
      }),
    ).toBe(true);
    expect(
      await browser.execute(() => document.querySelector('.agent-conversation')?.scrollTop ?? -1),
    ).toBe(beforeReply);

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Cancel creation');
    await $('.agent-actions button').click();
    await browser.keys('Escape');
    await expect($('.agent-busy')).not.toBeDisplayed();
    await expect($('.agent-composer textarea')).toHaveValue('Cancel creation');
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Cancel creation'),
    );
  });
});
