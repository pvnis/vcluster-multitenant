// Plain Kubernetes objects rendered from the templates: Namespace, quota,
// network policies, the Prometheus label proxy.
//
// Observe: server-side dry-run apply of each object, compared with the live
// one; differences become drift. Nothing is changed.
// Manage:  apply each object (taking ownership of fields kubectl set), and
// delete the ones that must be absent.

import type { KubernetesObject } from '@kubernetes/client-node';
import type { Kube } from '../kube.ts';
import { ref } from '../kube.ts';
import { diffPaths, normalise } from '../diff.ts';
import type { ComponentResult, Drift, Management } from '../types.ts';

export async function reconcileObjects(
  kube: Kube,
  component: string,
  present: KubernetesObject[],
  absent: KubernetesObject[],
  mode: Management,
): Promise<ComponentResult> {
  const drift: Drift[] = [];
  for (const want of present) {
    const live = await kube.read(want);
    if (mode === 'Observe') {
      if (!live) {
        drift.push({ component, object: ref(want), change: 'create', paths: [] });
        continue;
      }
      const would = await kube.apply(want, true);
      const paths = diffPaths(normalise(live), normalise(would));
      if (paths.length) drift.push({ component, object: ref(want), change: 'update', paths });
    } else {
      await kube.apply(want);
    }
  }
  for (const gone of absent) {
    if (mode === 'Observe') {
      if (await kube.read(gone)) drift.push({ component, object: ref(gone), change: 'delete', paths: [] });
    } else {
      await kube.delete(gone);
    }
  }
  const n = drift.length;
  return {
    drift,
    condition: {
      type: `${component}Ready`,
      status: mode === 'Manage' || n === 0 ? 'True' : 'False',
      reason: mode === 'Manage' ? 'Applied' : n === 0 ? 'InSync' : 'Drift',
      message: mode === 'Manage'
        ? `${present.length} applied, ${absent.length} ensured absent`
        : n === 0 ? `${present.length} objects match` : `${n} object(s) would change`,
    },
  };
}
