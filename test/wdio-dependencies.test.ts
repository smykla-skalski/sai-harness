import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adapterFactory } from '@wdio/mocha-framework';

await test('overridden WebdriverIO runner and reporter dependencies work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sail-wdio-smoke-'));

  try {
    const spec = join(directory, 'sample.cjs');
    writeFileSync(
      spec,
      'describe("smoke", () => { it("runs", () => { if (2 + 2 !== 4) throw new Error("bad math") }) })',
    );

    const reporter = new EventEmitter();
    const events: { type: string; title: string }[] = [];
    for (const type of ['suite:start', 'test:start', 'test:pass', 'test:end', 'suite:end']) {
      reporter.on(type, (event) => events.push({ type, title: event.title }));
    }

    const adapter = await adapterFactory.init(
      'smoke',
      { rootDir: directory, mochaOpts: { ui: 'bdd', timeout: 5000 } },
      [spec],
      {},
      reporter,
    );
    assert.equal(adapter.hasTests(), true);
    assert.equal(await adapter.run(), 0);
    assert.ok(events.some((event) => event.type === 'test:pass' && event.title === 'runs'));

    const frameworkRequire = createRequire(import.meta.resolve('@wdio/mocha-framework'));
    const reporterRequire = createRequire(import.meta.resolve('@wdio/spec-reporter'));
    const { TestStats } = await import(reporterRequire.resolve('@wdio/reporter'));
    const stats = new TestStats({
      uid: 'smoke',
      cid: 'smoke',
      title: 'diff',
      fullTitle: 'diff',
      parent: 'smoke',
    });
    stats.fail([{ message: 'assertion failed', actual: 'left', expected: 'right', stack: '' }]);
    assert.match(stats.error.message, /actual.*expected/s);

    const mochaBin = frameworkRequire.resolve('mocha/bin/mocha.js');
    const parallel = spawnSync(
      process.execPath,
      [mochaBin, '--parallel', '--reporter', 'json', spec],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(parallel.status, 0, parallel.stderr);
    assert.equal(JSON.parse(parallel.stdout).stats.passes, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
