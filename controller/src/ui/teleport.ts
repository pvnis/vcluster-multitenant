// Operator-console issuing of Teleport agent (Machine ID) join tokens. The
// tenant has no access until it holds a token, so the operator mints one here
// and hands it over out of band — there is nowhere tenant-readable to drop it.
//
// Per agent: a TeleportBotV1 (the bot, bound to the tenant's <tenant>-access
// role) and a TeleportProvisionToken (join_method token; the token value IS the
// resource name). Both are operator CRs the teleport-operator reconciles into
// Auth. Issuing a new token first deletes the agent's prior tokens, so only the
// freshly-shown one is ever valid — a standing credential never accumulates.

import { randomBytes } from 'node:crypto';
import type { KubernetesObject } from '@kubernetes/client-node';
import type { Kube } from '../kube.ts';

const NS = process.env.TELEPORT_NAMESPACE ?? 'teleport';
const PROXY_HOST = process.env.TELEPORT_PROXY_HOST ?? 'teleport.midori.phoenix.tyo';
const PROXY_VIP = process.env.TELEPORT_PROXY_VIP ?? '119.15.113.134';
const MANAGER = 'tenant-ui';
const TENANT_LABEL = 'midori.phoenix/tenant';
const AGENT_LABEL = 'midori.phoenix/agent';
// A DNS-safe, short agent name; combined with the tenant it forms the bot name.
const AGENT_RE = /^[a-z0-9]([-a-z0-9]{0,28}[a-z0-9])?$/;

export class BadAgent extends Error {}

export function validateAgent(agent: string): string {
  if (!AGENT_RE.test(agent)) throw new BadAgent('agent name: 2-30 chars, lowercase letters/digits/-, start and end alphanumeric');
  return agent;
}

const botName = (tenant: string, agent: string) => `${tenant}-${agent}`;

// The bot identity, bound to the tenant's scoped role.
export function botCR(tenant: string, agent: string): KubernetesObject {
  return {
    apiVersion: 'resources.teleport.dev/v1',
    kind: 'TeleportBotV1',
    metadata: { name: botName(tenant, agent), namespace: NS, labels: { [TENANT_LABEL]: tenant, [AGENT_LABEL]: agent } },
    spec: { roles: [`${tenant}-access`] },
  } as KubernetesObject;
}

// A token-join provision token for the bot; the token value is the resource name.
export function tokenCR(tenant: string, agent: string, token: string): KubernetesObject {
  return {
    apiVersion: 'resources.teleport.dev/v2',
    kind: 'TeleportProvisionToken',
    metadata: { name: token, namespace: NS, labels: { [TENANT_LABEL]: tenant, [AGENT_LABEL]: agent } },
    spec: { roles: ['Bot'], join_method: 'token', bot_name: botName(tenant, agent) },
  } as KubernetesObject;
}

// A ready-to-run tbot config for the tenant's host. Self-signed Proxy today, so
// the agent runs `tbot start -c <file> --insecure` (ca_pins is mutually exclusive
// with --insecure in tbot, and the Proxy cert is CN=localhost) and needs the
// Proxy name resolvable to the VIP. All of that drops once a real cert is in place.
export function tbotConfig(tenant: string, token: string): string {
  return [
    'version: v2',
    'onboarding:',
    '  join_method: token',
    `  token: ${token}`,
    'storage: { type: directory, path: ./.tbot }',
    `proxy_server: ${PROXY_HOST}:443`,
    'outputs:',
    '  - type: kubernetes',
    '    destination: { type: directory, path: ./.tbot/kube }',
    `    kubernetes_cluster: ${tenant}`,
    '',
  ].join('\n');
}

type WithStatus = KubernetesObject & { status?: { conditions?: Array<{ type: string; status: string }> } };
function reconciled(cr: WithStatus | undefined): boolean {
  return !!cr?.status?.conditions?.some((c) => c.type === 'SuccessfullyReconciled' && c.status === 'True');
}

async function listCRs(kube: Kube, plural: string, version: string, tenant: string, agent?: string): Promise<KubernetesObject[]> {
  const sel = encodeURIComponent(agent ? `${TENANT_LABEL}=${tenant},${AGENT_LABEL}=${agent}` : `${TENANT_LABEL}=${tenant}`);
  const r = await kube.getPath<{ items: KubernetesObject[] }>(`/apis/resources.teleport.dev/${version}/namespaces/${NS}/${plural}?labelSelector=${sel}`);
  return r.items ?? [];
}

async function deleteTokensFor(kube: Kube, tenant: string, agent: string): Promise<void> {
  for (const t of await listCRs(kube, 'teleportprovisiontokens', 'v2', tenant, agent)) await kube.delete(t);
}

export interface IssuedToken {
  agent: string; botName: string; kubeCluster: string; proxy: string; vip: string; token: string; config: string;
}

// Mint (or re-issue) a join token for an agent; returns everything the operator
// hands to the tenant. Re-issuing invalidates the agent's previous token.
export async function issueAgentToken(kube: Kube, tenant: string, agentRaw: string): Promise<IssuedToken> {
  const agent = validateAgent(agentRaw);
  await kube.apply(botCR(tenant, agent), false, MANAGER);          // ensure the bot
  await deleteTokensFor(kube, tenant, agent);                      // drop old tokens
  const token = randomBytes(16).toString('hex');
  const ref = tokenCR(tenant, agent, token);
  await kube.apply(ref, false, MANAGER);                           // mint the new one
  // Wait for the operator to reconcile it into Auth so the handed-out token works.
  for (let i = 0; i < 20; i++) {
    if (reconciled(await kube.read<WithStatus>(ref))) break;
    await new Promise((s) => setTimeout(s, 750));
  }
  return { agent, botName: botName(tenant, agent), kubeCluster: tenant, proxy: `${PROXY_HOST}:443`, vip: PROXY_VIP, token, config: tbotConfig(tenant, token) };
}

export async function listAgents(kube: Kube, tenant: string): Promise<Array<{ agent: string; botName: string }>> {
  const bots = await listCRs(kube, 'teleportbotsv1', 'v1', tenant);
  return bots
    .map((b) => ({ agent: b.metadata?.labels?.[AGENT_LABEL] ?? '', botName: b.metadata?.name ?? '' }))
    .filter((a) => a.agent)
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

// Revoke an agent: delete the bot (kills all its identities) and its tokens.
export async function revokeAgent(kube: Kube, tenant: string, agentRaw: string): Promise<void> {
  const agent = validateAgent(agentRaw);
  await deleteTokensFor(kube, tenant, agent);
  await kube.delete(botCR(tenant, agent));
}
