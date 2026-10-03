import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ACP agent threads', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-acp-e2e-'));

  async function selectClaudeThread(title: string) {
    await browser.keys(['Meta', 'k']);
    const search = $('[aria-label="Search command palette"]');
    await search.setValue(repository.split('/').at(-1)!);
    await browser.keys('Enter');
    await $('[data-kind="worktree"]').click();
    await search.setValue('Claude');
    await browser.keys('Enter');
    await search.setValue(title);
    await browser.keys('Enter');
  }

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
    await $('.agent-composer textarea').setValue('/');
    await expect($('.skill-menu')).toHaveText(
      expect.stringContaining('Implement and ship a GitHub issue'),
    );
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    expect(await $('.agent-composer textarea').getValue()).toBe('/review ');
    await $('.agent-composer textarea').setValue('/model');
    await browser.keys('Enter');
    await expect($('.option-menu[role="listbox"]')).toBeDisplayed();
    await expect($('.option-menu button[role="option"]:nth-child(2)')).toBeDisplayed();
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    await $('.option-trigger[aria-label^="Model:"]').click();
    await $('.option-menu button[role="option"]:nth-child(3)').click();
    await $('.agent-composer textarea').setValue('Keep this draft');
    await $('.agent-actions button').click();
    await expect($('.agent-error')).toHaveText(expect.stringContaining('Model change rejected'));
    await expect($('.agent-composer textarea')).toHaveValue('Keep this draft');
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Keep this draft'),
    );
    await $('.option-trigger[aria-label^="Model:"]').click();
    await $('.option-menu button[role="option"]:nth-child(2)').click();
    await $('.agent-composer textarea').setValue('');
    await $('.agent-composer textarea').setValue('/effort');
    await browser.keys('Enter');
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );
    await $('.agent-composer textarea').setValue('Do a small thing');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toHaveText(expect.stringContaining('Run test action'));
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
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
    await $('.agent-picker-controls .option-trigger[aria-label^="Effort:"]').click();
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );

    try {
      await selectClaudeThread('Do a small thing');
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
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );
    await browser.refresh();
    try {
      await selectClaudeThread('Do a small thing');
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
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-launches button:nth-child(2)').click();
    await browser.pause(1800);
    await selectClaudeThread('Delayed approval');
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
    await expect($('.agent-tool-group')).toHaveText(expect.stringContaining('cancelled'));

    await $('.agent-composer textarea').setValue('Slow cancel');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.agent-tool-current')).toHaveText(expect.stringContaining('stopping'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-tool-group')).toHaveText(expect.stringContaining('cancelled'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));

    await $('.agent-composer textarea').setValue('Long answer');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    const beforeReply = await browser.execute(() => {
      const conversation = document.querySelector('.agent-conversation');
      if (!conversation) return -1;
      conversation.scrollTop = conversation.scrollHeight;
      conversation.dispatchEvent(new Event('scroll'));
      return conversation.scrollTop;
    });
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
    ).toBeGreaterThan(beforeReply);

    await $('.agent-composer textarea').setValue('Activity demo');
    await $('.agent-actions button').click();
    await expect($('.agent-tool-current')).toBeDisplayed();
    await browser.execute(() => {
      const conversation = document.querySelector('.agent-conversation');
      if (conversation) {
        conversation.scrollTop = 0;
        conversation.dispatchEvent(new Event('scroll'));
      }
    });
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('The checks passed. The tool details are available above.'),
    );
    expect(
      await browser.execute(() => document.querySelector('.agent-conversation')?.scrollTop),
    ).toBe(0);

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

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Disable effort');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Disable effort'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('/effort');
    await browser.keys('Enter');
    await expect($('.option-menu')).toHaveText(
      expect.stringContaining('No choices available for this model or agent.'),
    );
  });

  it('queues a typed message until the current ACP turn finishes', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-composer textarea').setValue('Queued follow-up');
    await $('.agent-actions button').click();
    await expect($('.queued-messages')).toHaveText(expect.stringContaining('Queued follow-up'));
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Delayed approval'),
    );
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Queued follow-up'),
    );
    await expect($('.queued-messages')).not.toExist();
  });

  it('keeps agent messages and failures visible around grouped tool activity', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Activity failure demo');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('I recovered from the read failure'),
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const group = $('.agent-tool-group');
    await expect($$('.agent-tool-group')).toBeElementsArrayOfSize(2);
    await expect(group).toHaveText(expect.stringContaining('2 actions'));
    await expect(group).toHaveText(expect.stringContaining('Failed'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('The first read failed. I’m searching another path.'),
    );
    await group.$('summary').click();
    await expect(group.$$('.agent-tool-item')).toBeElementsArrayOfSize(2);
    await expect(group).toHaveText(expect.stringContaining('Could not read the first path.'));
  });

  it('shows an agent shell command and its output in tool activity', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Activity demo');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('The checks passed.'),
    );
    const group = $('.agent-tool-group');
    await group.$('summary').click();
    const command = group.$('.tool-activity-command');
    await expect(command).toHaveText('npm test');
    const tools = await group.$$('.tool-activity');
    await tools.at(-1)!.$('summary').click();
    await expect(group).toHaveText(expect.stringContaining('All checks passed.'));
  });

  it('manages the focused split thread without removing the main thread', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sai-pane-layouts');
      localStorage.removeItem('sail-agent-threads');
    }, realpathSync(repository));
    await browser.refresh();
    await $('.agent-launches button').click();
    await $('.agent-composer textarea').setValue('Main action');
    await $('.agent-actions button').click();
    await expect($('.agent-permission button')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Done: Main action'));
    await browser.keys(['Meta', 'd']);
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeDisplayed();
    await $('.agent-launches button').click();
    await $('.pane-leaf.focused .agent-composer textarea').setValue('Split action');
    await $('.pane-leaf.focused .agent-actions button').click();
    await expect($('.pane-leaf.focused .agent-permission button')).toBeDisplayed();
    await $('.pane-leaf.focused .agent-permission button').click();
    await expect($('.pane-leaf.focused .agent-conversation')).toHaveText(
      expect.stringContaining('Done: Split action'),
    );
    await $('[aria-label="Remove thread"]').click();
    const titles = await browser.execute(() =>
      JSON.parse(localStorage.getItem('sail-agent-threads') ?? '[]').map(
        (thread: { title: string }) => thread.title,
      ),
    );
    expect(titles).toContain('Main action');
    expect(titles).not.toContain('Split action');
  });
});
