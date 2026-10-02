import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('project context menus', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-project-menu-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('opens the same management menu from dots and right click', async () => {
    const path = realpathSync(repository);
    await browser.execute((selectedPath) => {
      localStorage.setItem('sai-directory', selectedPath);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({
          repositories: [selectedPath],
          groups: [{ id: 'work', name: 'Work', collapsed: false, repositories: [selectedPath] }],
          worktrees: {},
        }),
      );
    }, path);
    await browser.refresh();
    await browser.setWindowSize(1280, 850);
    await expect($('.project-default-worktree-select')).toHaveAttribute('aria-current', 'page');

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

    await $('.project-repository-row .project-icon-button:last-child').click();
    await expect($('.project-menu')).toHaveText(expect.stringContaining('Move to'));
    await expect($('.project-menu')).toHaveText(expect.stringContaining('Remove from sidebar'));
    await expect($('.project-menu button:nth-of-type(2)')).toHaveAttribute(
      'aria-label',
      expect.stringContaining(' to Ungrouped'),
    );
    await expect($('.project-menu button.danger')).toBeDisabled();
    await $('.brand').click();
    await expect($('.project-menu')).not.toExist();

    await browser.execute(() => {
      document.querySelector('.project-repository-row')?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: innerWidth - 2,
          clientY: innerHeight - 2,
        }),
      );
    });
    await expect($('.project-menu')).toBeDisplayed();
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
    expect(bounds.right).toBeGreaterThan(bounds.width - 40);
    expect(bounds.bottom).toBeGreaterThan(bounds.height - 40);
    await $('.brand').click();
    await expect($('.project-menu')).not.toExist();

    await $('.project-repository-select').click({ button: 'right' });
    await expect($('.project-menu')).toBeDisplayed();
    await $('.project-menu button:nth-of-type(2)').click();
    await expect($('.project-menu')).not.toExist();
    await expect($('.project-group-label')).toHaveText('Ungrouped');
  });

  it('toggles worktrees while keeping the default checkout under its project', async () => {
    const path = realpathSync(repository);
    const linked = join(path, 'linked');
    await browser.execute(
      (selectedPath, linkedPath) => {
        localStorage.setItem('sai-directory', selectedPath);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [selectedPath],
            groups: [{ id: 'work', name: 'Work', collapsed: false, repositories: [selectedPath] }],
            worktrees: { [selectedPath]: [{ path: linkedPath, branch: 'feature' }] },
          }),
        );
      },
      path,
      linked,
    );
    await browser.refresh();
    const project = $('.project-repository-select');
    const defaultWorktree = $('.project-default-worktree-select');
    const linkedWorktree = $(`.project-worktree-select[title="${linked}"]`);
    await expect(project).toHaveAttribute('aria-expanded', 'true');
    await expect(defaultWorktree).toHaveAttribute('aria-current', 'page');
    await expect(linkedWorktree).toBeDisplayed();

    await project.click();
    await expect(project).toHaveAttribute('aria-expanded', 'false');
    await expect(defaultWorktree).not.toExist();
    await expect(linkedWorktree).not.toExist();
    expect(
      await browser.execute(() => JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}')),
    ).toHaveProperty('collapsedRepositories', [path]);
    await browser.refresh();
    await expect(project).toHaveAttribute('aria-expanded', 'false');
    await project.click();
    await expect(defaultWorktree).toHaveAttribute('aria-current', 'page');
    await expect(linkedWorktree).toBeDisplayed();

    await browser.execute(
      (selectedPath, linkedPath) =>
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [selectedPath],
            groups: [],
            worktrees: { [selectedPath]: [{ path: linkedPath, branch: 'feature' }] },
          }),
        ),
      path,
      linked,
    );
    await browser.refresh();
    await expect($('.project-group-label')).toHaveText('Ungrouped');
    await project.click();
    await expect(defaultWorktree).not.toExist();
    await expect(linkedWorktree).not.toExist();
  });
});
