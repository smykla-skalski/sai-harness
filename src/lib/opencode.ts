import { OpenCode, type OpenCodeClient } from '@opencode/client';

export type { OpenCodeClient };
export type { SessionInfo, SessionMessageInfo } from '@opencode/client';

export interface RuntimeInfo {
  url: string;
  password: string;
  binaryPath: string;
}

export function connect(info: RuntimeInfo): OpenCodeClient {
  return OpenCode.make({
    baseUrl: info.url,
    headers: { authorization: `Basic ${btoa(`opencode:${info.password}`)}` },
  });
}
