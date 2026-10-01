import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfigGetOutput } from '@opencode/client';
import { planPluginConfigured } from '../src/lib/onboarding.ts';

const config = (plugins: Array<string | { package: string }>): ConfigGetOutput =>
  [{ type: 'document', info: { plugins } }] as ConfigGetOutput;

await test('automatic setup restart targets only configured plan-review plugins', () => {
  assert.equal(planPluginConfigured(config([])), false);
  assert.equal(planPluginConfigured(config(['another-plugin'])), false);
  assert.equal(
    planPluginConfigured(config(['github:smykla-skalski/opencode-plugin-plan-review#revision'])),
    true,
  );
  assert.equal(
    planPluginConfigured(config([{ package: '@smykla-skalski/opencode-plugin-plan-review' }])),
    true,
  );
});
