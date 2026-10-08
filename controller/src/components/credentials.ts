// A tenant's credentials, in one Secret the operator can hand over:
//   tenant-system/<tenant>-credentials
//     s3-access-key, s3-secret-key, s3-endpoint   (the S3 gateway)
//     grafana-user, grafana-password               (its Grafana org)
// Values already present are kept, so adopting a tenant preserves the key
// and password it already has (import them first; see README).

import { randomBytes } from 'node:crypto';
import type { V1Secret } from '@kubernetes/client-node';
import type { Kube } from '../kube.ts';
import { KUBECONFIG_NAMESPACE } from './vcluster.ts';

export interface Credentials {
  s3AccessKey: string;
  s3SecretKey: string;
  grafanaUser: string;
  grafanaPassword: string;
}

export const S3_ENDPOINT = 'http://s3-gateway.s3-gateway.svc.cluster.local:8080';

const secretRef = (tenant: string) => ({
  apiVersion: 'v1', kind: 'Secret', metadata: { name: `${tenant}-credentials`, namespace: KUBECONFIG_NAMESPACE },
});

export async function readCredentials(kube: Kube, tenant: string): Promise<Partial<Credentials> | undefined> {
  const s = await kube.read<V1Secret>(secretRef(tenant));
  if (!s) return undefined;
  const d = (k: string) => (s.data?.[k] ? Buffer.from(s.data[k], 'base64').toString() : undefined);
  return { s3AccessKey: d('s3-access-key'), s3SecretKey: d('s3-secret-key'), grafanaUser: d('grafana-user'), grafanaPassword: d('grafana-password') };
}

// Fills in whatever is missing and writes the Secret (Manage only).
export async function ensureCredentials(kube: Kube, tenant: string): Promise<Credentials> {
  const have = (await readCredentials(kube, tenant)) ?? {};
  const c: Credentials = {
    s3AccessKey: have.s3AccessKey ?? `${tenant}-${randomBytes(4).toString('hex')}`,
    s3SecretKey: have.s3SecretKey ?? randomBytes(24).toString('hex'),
    grafanaUser: have.grafanaUser ?? tenant,
    grafanaPassword: have.grafanaPassword ?? randomBytes(18).toString('base64url'),
  };
  const s: V1Secret = {
    ...secretRef(tenant),
    metadata: { ...secretRef(tenant).metadata, labels: { 'midori.phoenix/tenant': tenant } },
    type: 'Opaque',
    stringData: {
      's3-access-key': c.s3AccessKey, 's3-secret-key': c.s3SecretKey, 's3-endpoint': S3_ENDPOINT,
      'grafana-user': c.grafanaUser, 'grafana-password': c.grafanaPassword,
    },
  };
  await kube.apply(s);
  return c;
}

export async function deleteCredentials(kube: Kube, tenant: string): Promise<void> {
  await kube.delete(secretRef(tenant));
  await kube.delete({ ...secretRef(tenant), metadata: { name: `${tenant}-kubeconfig`, namespace: KUBECONFIG_NAMESPACE } });
}
