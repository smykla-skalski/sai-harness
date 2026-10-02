import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('project context menus', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-project-menu-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('opens the same management menu from dots and right click', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({
          repositories: [path],
          groups: [{ id: 'work', name: 'Work', collapsed: false, repositories: [path] }],
          worktrees: {},
        }),
      );
    }, repository);
    await browser.refresh();
    await browser.setWindowSize(1280, 850);

    await $('[aria-label="Manage Work"]').click();
    try {
      await expect($('.project-menu')).toBeDisplayed();
    } catch (cause) {
      console.error(
        'Group menu diagnostic',
        await browser.execute(() => ({
          menu: document.querySelector('.project-menu')?.outerHTML,
          expanded: document
            .querySelector('[aria-label="Manage Work"]')
            ?.getAttribute('aria-expanded'),
          focused:
            document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
          viewport: { width: innerWidth, height: innerHeight },
          sidebarVisible: getComputedStyle(document.querySelector('.sidebar')!).display,
        })),
      );
      throw cause;
    }
    await expect($('.project-menu')).toHaveText(expect.stringContaining('Rename group'));
    await browser.keys('Escape');
    await expect($('.project-menu')).not.toExist();
    await expect($('[aria-label="Manage Work"]')).toBeFocused();

    await $('.project-group-toggle').click({ button: 'right' });
    await expect($('.project-menu')).toBeDisplayed();
    await browser.keys('ArrowDown');
    await expect($('.project-menu button:nth-of-type(2)')).toBeFocused();
    await $('.project-menu button[role="menuitem"]:nth-of-type(2)').click();
    await expect($('[aria-label="Rename Work"]')).toBeFocused();
    await browser.keys('Escape');

    const repoName = repository.split('/').at(-1)!;
    await $(`[aria-label="Manage ${repoName}"]`).click();
    await expect($('.project-menu')).toHaveText(expect.stringContaining('Move to'));
    await expect($('.project-menu')).toHaveText(expect.stringContaining('Remove from sidebar'));
    await expect($('.project-menu button.danger')).toBeDisabled();
    const bounds = await browser.execute(() => {
      const rect = document.querySelector('.project-menu')!.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
    await $('.brand').click();
    await expect($('.project-menu')).not.toExist();

    await $(`.project-repository-select[title="${repository}"]`).click({ button: 'right' });
    await expect($('.project-menu')).toBeDisplayed();
    await $('.project-menu button:nth-of-type(2)').click();
    await expect($('.project-menu')).not.toExist();
    await expect($('.project-group-label')).toHaveText('Ungrouped');
  });
});
