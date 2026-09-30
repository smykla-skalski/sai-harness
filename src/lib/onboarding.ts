import { invoke } from '@tauri-apps/api/core';
import type { OpenCodeClient, PluginInfo } from '@opencode/client';

export type SetupCheck = { state: 'ready' | 'action'; detail: string };
export type SetupReport = {
  repository: string;
  location: SetupCheck;
  plugin: SetupCheck;
  architect: SetupCheck;
  rpc: SetupCheck;
  model: SetupCheck;
  ready: boolean;
};

function check(detail: string, ready: boolean): SetupCheck {
  return { state: ready ? 'ready' : 'action', detail };
}

function problem(result: PromiseRejectedResult): SetupCheck {
  const reason = result.reason;
  return check(reason instanceof Error ? reason.message : String(reason), false);
}

function planPlugin(plugin: PluginInfo): boolean {
  return (
    plugin.id === 'smykla.plan-review' ||
    (plugin.source.type === 'package' &&
      plugin.source.target.includes('@smykla-skalski/opencode-plugin-plan-review')) ||
    (plugin.source.type === 'local' && plugin.source.path.includes('opencode-plugin-plan-review'))
  );
}

export async function inspectRepository(
  client: OpenCodeClient,
  selected: string,
): Promise<SetupReport> {
  const repository = await invoke<string>('validate_repository', { path: selected });
  const location = { directory: repository };
  const [
    foundLocation,
    foundPlugins,
    foundAgents,
    foundDefault,
    foundModels,
    foundProviders,
    foundIntegrations,
    foundRpc,
  ] = await Promise.allSettled([
    client.location.get({ location }),
    client.plugin.list({ location }),
    client.agent.list({ location }),
    client.model.default({ location }),
    client.model.list({ location }),
    client.provider.list({ location }),
    client.integration.list({ location }),
    client.rpc.call({
      rpcID: 'planreview',
      method: 'get',
      location,
      input: { sessionID: '__sai_setup_probe__' },
    }),
  ]);

  const locationCheck =
    foundLocation.status === 'fulfilled'
      ? check(`OpenCode location: ${foundLocation.value.project.canonical}`, true)
      : problem(foundLocation);

  let pluginCheck: SetupCheck;
  if (foundPlugins.status === 'rejected') {
    pluginCheck = problem(foundPlugins);
  } else {
    const plugin = foundPlugins.value.data.find(planPlugin);
    if (!plugin) {
      pluginCheck = check('Plan-review plugin not loaded', false);
    } else if (plugin.state.status === 'failed') {
      pluginCheck = check(`Plan-review plugin failed: ${plugin.state.error}`, false);
    } else if (plugin.source.type === 'package') {
      pluginCheck = check(
        `Published plugin ${plugin.source.version ?? 'version unknown'} (${plugin.source.target})`,
        true,
      );
    } else if (plugin.source.type === 'local') {
      const version = await invoke<string | null>('local_plugin_version', {
        path: plugin.source.path,
      });
      pluginCheck = check(
        `Local checkout ${version ?? 'version unknown'} (${plugin.source.path})`,
        true,
      );
    } else {
      pluginCheck = check('Plan-review plugin loaded (version unknown)', true);
    }
  }

  const architect =
    foundAgents.status === 'fulfilled'
      ? foundAgents.value.data.find((agent) => agent.id === 'architect')
      : undefined;
  const architectCheck =
    foundAgents.status === 'rejected'
      ? problem(foundAgents)
      : check(
          architect ? 'Architect agent available' : 'Architect agent not configured',
          !!architect,
        );

  const rpcOutput: unknown = foundRpc.status === 'fulfilled' ? foundRpc.value.output : null;
  const rpcCheck =
    pluginCheck.state !== 'ready'
      ? check('planreview RPC unavailable until the plugin loads', false)
      : foundRpc.status === 'fulfilled' &&
          typeof rpcOutput === 'object' &&
          rpcOutput !== null &&
          'plan' in rpcOutput &&
          'questions' in rpcOutput
        ? check('planreview RPC responds', true)
        : check(
            `planreview RPC unavailable${foundRpc.status === 'rejected' ? `: ${problem(foundRpc).detail}` : ''}`,
            false,
          );

  let modelCheck: SetupCheck;
  if (foundDefault.status === 'rejected') {
    modelCheck = problem(foundDefault);
  } else if (foundProviders.status === 'rejected') {
    modelCheck = problem(foundProviders);
  } else if (foundIntegrations.status === 'rejected') {
    modelCheck = problem(foundIntegrations);
  } else {
    const preferred = architect?.model;
    const model = preferred
      ? foundModels.status === 'fulfilled'
        ? foundModels.value.data.find(
            (item) => item.id === preferred.id && item.providerID === preferred.providerID,
          )
        : undefined
      : foundDefault.value.data;
    const provider =
      model && foundProviders.value.data.find((item) => item.id === model.providerID);
    const integration = provider?.integrationID
      ? foundIntegrations.value.data.find((item) => item.id === provider.integrationID)
      : undefined;
    const connected =
      !provider?.integrationID ||
      !!integration?.connections.some((item) => item.status?.status !== 'needs_auth');
    modelCheck = model
      ? check(
          `${provider?.name ?? model.providerID} / ${model.name}${!connected ? ' (connect provider in OpenCode)' : model.enabled ? '' : ' (disabled)'}`,
          model.enabled && !!provider && provider.activation !== 'disabled' && connected,
        )
      : check('No usable model selected. Configure an OpenCode provider and default model.', false);
  }

  const checks = [locationCheck, pluginCheck, architectCheck, rpcCheck, modelCheck];
  return {
    repository,
    location: locationCheck,
    plugin: pluginCheck,
    architect: architectCheck,
    rpc: rpcCheck,
    model: modelCheck,
    ready: checks.every((item) => item.state === 'ready'),
  };
}
