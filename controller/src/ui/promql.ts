// GPU memory as held and as used, from Prometheus -- what ResourceQuota cannot
// say. Since 2026-10-08 the gVisor webhook gives a whole-GPU pod a card's
// nvidia.com/gpumem, so the quota charges it; pods admitted before that (or
// with the webhook's --nvidia-whole-card-mib off) declare none and are
// counted at a full card here.
//
// HELD, per tenant namespace: each running pod's nvidia.com/gpumem x its GPUs
// for a slice, or a card's full memory per GPU for a whole-card pod;
// max-by-labels first so duplicate kube-state-metrics series (during its
// restarts) cannot double-count. The same rule as the admin Grafana panel
// "GPU memory held" (manifests/midori/observability/dashboards/build.py,
// gpu_alloc()); keep the two in step.
// USED: DCGM's measured framebuffer use, summed over the cards.

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://kps-kube-prometheus-stack-prometheus.observability.svc:9090';
export const CARD_MIB = Number(process.env.GPU_CARD_MIB ?? 46068); // RTX A6000

const lim = (r: string) => `max by (namespace, pod, container) (kube_pod_container_resource_limits{resource="${r}", namespace=~"tenant-.+"})`;
export const HELD_BY_TENANT =
  `sum by (namespace) (((${lim('nvidia_com_gpumem')} * on (namespace, pod, container) ${lim('nvidia_com_gpu')}) ` +
  `or on (namespace, pod, container) ${lim('nvidia_com_gpu')} * ${CARD_MIB}) ` +
  `* on (namespace, pod) group_left () max by (namespace, pod) (kube_pod_status_phase{phase="Running", namespace=~"tenant-.+"} == 1))`;
export const USED_TOTAL = 'sum(max by (hostname, gpu) (DCGM_FI_DEV_FB_USED))';

async function query(expr: string): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
  const r = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`prometheus ${r.status}`);
  const j = (await r.json()) as { data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } };
  return j.data.result;
}

export interface GpuMemory {
  available: boolean;              // false: Prometheus unreachable, fall back to quota "requested"
  heldByTenant: Record<string, number>;  // MiB
  heldMiB: number;
  usedMiB: number | null;          // measured on the cards (DCGM)
}

export async function gpuMemory(): Promise<GpuMemory> {
  try {
    const [held, used] = await Promise.all([query(HELD_BY_TENANT), query(USED_TOTAL)]);
    const heldByTenant = Object.fromEntries(held.map((r) => [r.metric.namespace, Number(r.value[1])]));
    return {
      available: true,
      heldByTenant,
      heldMiB: Object.values(heldByTenant).reduce((a, b) => a + b, 0),
      usedMiB: used.length ? Number(used[0].value[1]) : null,
    };
  } catch {
    return { available: false, heldByTenant: {}, heldMiB: 0, usedMiB: null };
  }
}
