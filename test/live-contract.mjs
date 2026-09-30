import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/client';

const cli = process.env.SAI_OPENCODE_BIN || 'opencode';
const plugin =
  process.env.SAI_PLUGIN_PATH ||
  'github:smykla-skalski/opencode-plugin-plan-review#fdc575ba5ffccc6420ad5b3b68372f99f70290f5';
const root = mkdtempSync(join(tmpdir(), 'sai-contract-'));
const repository = join(root, 'repository');
const config = join(root, 'config');
const env = {
  ...process.env,
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
};
let server;

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve) => listener.close(resolve));
  return address.port;
}

async function ready(url, authorization, attempt = 0) {
  if (attempt >= 120) throw new Error('OpenCode did not become ready within 60 seconds');
  if (server.exitCode !== null) throw new Error(`OpenCode exited: ${server.exitCode}`);
  try {
    const response = await fetch(`${url}/api/info`, {
      headers: { authorization },
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) return;
  } catch {
    await delay(500);
    return ready(url, authorization, attempt + 1);
  }
  await delay(500);
  return ready(url, authorization, attempt + 1);
}

async function untilPlugin(client, location, attempt = 0) {
  if (attempt >= 120) throw new Error('Plan-review plugin did not load within 60 seconds');
  const result = await client.plugin.list({ location });
  const installed = result.data.find((item) => item.id === 'smykla.plan-review');
  if (installed?.state.status === 'failed') throw new Error(installed.state.error);
  if (installed?.state.status === 'active') return;
  await delay(500);
  return untilPlugin(client, location, attempt + 1);
}

try {
  mkdirSync(repository);
  mkdirSync(config);
  execFileSync('git', ['init', '-q', repository]);
  writeFileSync(join(repository, 'opencode.jsonc'), JSON.stringify({ plugins: [plugin] }));
  const version = execFileSync(cli, ['--version'], { env, encoding: 'utf8' }).trim();
  assert.match(version, /^opencode v2\.0\.19$/);
  const port = await freePort();
  const password = 'sai-contract-test';
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const url = `http://127.0.0.1:${port}`;
  server = spawn(cli, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: repository,
    env: { ...env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (data) => process.stderr.write(data));
  server.stderr.on('data', (data) => process.stderr.write(data));
  await ready(url, authorization);
  const client = OpenCode.make({ baseUrl: url, headers: { authorization } });
  const location = { directory: repository };
  assert.equal(
    (await client.location.get({ location })).project.canonical,
    realpathSync(repository),
  );
  await untilPlugin(client, location);
  assert(Array.isArray((await client.agent.list({ location })).data));
  assert(Array.isArray((await client.model.list({ location })).data));
  assert(Array.isArray((await client.provider.list({ location })).data));
  assert(Array.isArray((await client.integration.list({ location })).data));

  const created = await client.session.create({ location });
  assert.match(created.id, /^ses_/);
  assert.equal((await client.session.get({ sessionID: created.id, location })).id, created.id);
  assert(Array.isArray((await client.session.list({ location })).data));
  assert(Array.isArray((await client.message.list({ sessionID: created.id, location })).data));
  assert(Array.isArray(await client.session.diff({ sessionID: created.id, location })));
  assert(Array.isArray(await client.permission.list({ sessionID: created.id, location })));
  assert(Array.isArray(await client.session.form.list({ sessionID: created.id, location })));

  const snapshot = (
    await client.rpc.call({
      rpcID: 'planreview',
      method: 'get',
      location,
      input: { sessionID: created.id },
    })
  ).output;
  assert(snapshot && typeof snapshot === 'object');
  assert('plan' in snapshot && 'questions' in snapshot);
  const history = (
    await client.rpc.call({
      rpcID: 'planreview',
      method: 'history',
      location,
      input: { sessionID: created.id },
    })
  ).output;
  assert(history && typeof history === 'object' && Array.isArray(history.events));
  await client.session.remove({ sessionID: created.id, location });
  console.log(`Live contract passed: ${version}, @opencode/client 2.0.20, ${plugin}`);
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5_000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(root, { recursive: true, force: true });
}
