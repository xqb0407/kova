import type { InboxConnectorProvider } from "pi-protocol";
import type { ConnectorAdapter } from "../types";
import { githubAdapter } from "./github";
import { gitlabAdapter } from "./gitlab";
import { jiraAdapter } from "./jira";
import { linearAdapter } from "./linear";

export const CONNECTOR_ADAPTERS: Record<
  InboxConnectorProvider,
  ConnectorAdapter
> = {
  github: githubAdapter,
  gitlab: gitlabAdapter,
  jira: jiraAdapter,
  linear: linearAdapter,
};

export function adapterFor(
  provider: InboxConnectorProvider,
): ConnectorAdapter {
  return CONNECTOR_ADAPTERS[provider];
}
