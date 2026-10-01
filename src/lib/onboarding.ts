import { invoke } from '@tauri-apps/api/core';
import type {
  AgentInfo,
  ConfigGetOutput,
  ModelInfo,
  ModelRef,
  OpenCodeClient,
  PluginInfo,
} from '@opencode/client';

export type SetupCheck = { state: 'ready' | 'action'; detail: string };
export type SetupReport = {
  repository: string;
  location: SetupCheck;
  plugin: SetupCheck;
  architect: SetupCheck;
  rpc: SetupCheck;
  model: SetupCheck;
  planModel: SetupCheck;
  agents: AgentInfo[];
  models: ModelInfo[];
  defaultModel: ModelRef | null;
  pluginConfigured: boolean;
  workReady: boolean;
  planReady: boolean;
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

export function planPluginConfigured(entries: ConfigGetOutput): boolean {
  return entries.some(
    (entry) =>
      entry.type === 'document' &&
      entry.info.plugins?.some((plugin) =>
        (typeof plugin === 'string' ? plugin : plugin.package).includes(
          'opencode-plugin-plan-review',
        ),
      ),
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
    foundConfig,
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
    client.config.get({ location }),
  ]);

  const pluginConfigured =
    foundConfig.status === 'fulfilled' && planPluginConfigured(foundConfig.value);

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

  const agents =
    foundAgents.status === 'fulfilled'
      ? foundAgents.value.data.filter((agent) => !agent.hidden && agent.mode !== 'subagent')
      : [];
  const models =
    foundModels.status === 'fulfilled' &&
    foundProviders.status === 'fulfilled' &&
    foundIntegrations.status === 'fulfilled'
      ? foundModels.value.data.filter((model) => {
          const provider = foundProviders.value.data.find((item) => item.id === model.providerID);
          const integration = provider?.integrationID
            ? foundIntegrations.value.data.find((item) => item.id === provider.integrationID)
            : undefined;
          return (
            model.enabled &&
            !!provider &&
            provider.activation !== 'disabled' &&
            (!provider.integrationID ||
              !!integration?.connections.some((item) => item.status?.status !== 'needs_auth'))
          );
        })
      : [];
  const preferred = foundDefault.status === 'fulfilled' ? foundDefault.value.data : null;
  const defaultModel =
    models.find(
      (model) => model.id === preferred?.id && model.providerID === preferred.providerID,
    ) ?? models[0];
  const modelCheck = defaultModel
    ? check(`${defaultModel.providerID} / ${defaultModel.name} available`, true)
    : check('No usable model. Connect a provider and enable a model in OpenCode.', false);
  const hasPlanModel = architect?.model
    ? models.some(
        (model) =>
          model.id === architect.model?.id && model.providerID === architect.model.providerID,
      )
    : !!defaultModel;
  const planModel = check(
    hasPlanModel
      ? 'Architect model available'
      : 'Architect model unavailable; connect or enable its provider',
    hasPlanModel,
  );
  const workReady = locationCheck.state === 'ready' && agents.length > 0 && models.length > 0;
  const planReady =
    locationCheck.state === 'ready' &&
    pluginCheck.state === 'ready' &&
    architectCheck.state === 'ready' &&
    rpcCheck.state === 'ready' &&
    planModel.state === 'ready';
  return {
    repository,
    location: locationCheck,
    plugin: pluginCheck,
    architect: architectCheck,
    rpc: rpcCheck,
    model: modelCheck,
    planModel,
    agents,
    models,
    defaultModel: defaultModel
      ? { id: defaultModel.id, providerID: defaultModel.providerID }
      : null,
    pluginConfigured,
    workReady,
    planReady,
    ready: planReady,
  };
}
