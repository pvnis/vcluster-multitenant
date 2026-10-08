#!/usr/bin/env python3
"""Generates midori's Grafana dashboards (JSON) next to this file.

    python3 build.py

tenant-overview.json  every tenant org: its pods, quota, GPU slice, network
                      drops and logs, by the names the tenant itself uses.
tenant-serving.json   tenant orgs that serve models (vLLM): load, latency,
                      KV cache, tokens.
admin-midori.json     the admin org: GPUs, the slicing broker, the services
                      that fail closed, per-tenant usage, alerts.

Tenant dashboards query datasources uid "prom" and "loki", which in a tenant
org are that tenant's prom-label-proxy and Loki tenant; every query is
therefore pinned to the tenant whatever it says.

gVisor note: cAdvisor sees a gVisor sandbox as ONE pod-level cgroup, with no
per-container series, so CPU/memory here use container="" -- dashboards that
filter container!="" (as kube-prometheus's do) show gVisor pods as empty.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
PROM = {"type": "prometheus", "uid": "prom"}
LOKI = {"type": "loki", "uid": "loki"}

# Host pod name -> the tenant's own pod name, via kube-state-metrics.
VPOD = ('* on (namespace, pod) group_left (vpod) '
        'label_replace(max by (namespace, pod, annotation_vcluster_loft_sh_object_name) '
        '(kube_pod_annotations{annotation_vcluster_loft_sh_object_name!=""}), '
        '"vpod", "$1", "annotation_vcluster_loft_sh_object_name", "(.+)")')


class Board:
    def __init__(self, uid, title, tags):
        self.uid, self.title, self.tags = uid, title, tags
        self.panels, self.y, self.next_id = [], 0, 1

    def row(self, title):
        self.panels.append({"type": "row", "title": title, "id": self._id(), "collapsed": False,
                            "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1}})
        self.y += 1

    def _id(self):
        self.next_id += 1
        return self.next_id

    def add(self, panels, h=8):
        """panels: list of (width, panel dict) laid out left to right."""
        x = 0
        for w, p in panels:
            p["id"] = self._id()
            p["gridPos"] = {"x": x, "y": self.y, "w": w, "h": h}
            self.panels.append(p)
            x += w
        self.y += h

    def json(self, variables=()):
        return {"uid": self.uid, "title": self.title, "tags": self.tags, "schemaVersion": 39,
                "editable": True, "time": {"from": "now-6h", "to": "now"}, "refresh": "30s",
                "templating": {"list": list(variables)}, "panels": self.panels}


def ts(title, targets, unit="short", ds=PROM, stack=False, desc=None):
    p = {"type": "timeseries", "title": title, "datasource": ds,
         "fieldConfig": {"defaults": {"unit": unit, "custom": {"fillOpacity": 10,
                         "stacking": {"mode": "normal" if stack else "none"}}}, "overrides": []},
         "options": {"legend": {"displayMode": "table", "placement": "right", "calcs": ["lastNotNull"]},
                     "tooltip": {"mode": "multi"}},
         "targets": [{"refId": chr(65 + i), "expr": e, "legendFormat": l, "datasource": ds}
                     for i, (e, l) in enumerate(targets)]}
    if desc:
        p["description"] = desc
    return p


def stat(title, expr, unit="short", thresholds=None, desc=None, legend=""):
    p = {"type": "stat", "title": title, "datasource": PROM,
         "fieldConfig": {"defaults": {"unit": unit, "thresholds": {"mode": "absolute",
                         "steps": thresholds or [{"color": "green", "value": None}]}}, "overrides": []},
         "options": {"colorMode": "background", "reduceOptions": {"calcs": ["lastNotNull"]}, "textMode": "value_and_name"},
         "targets": [{"refId": "A", "expr": expr, "legendFormat": legend, "datasource": PROM}]}
    if desc:
        p["description"] = desc
    return p


def bargauge(title, expr, legend, unit="percentunit", desc=None):
    p = {"type": "bargauge", "title": title, "datasource": PROM,
         "fieldConfig": {"defaults": {"unit": unit, "min": 0, "max": 1 if unit == "percentunit" else None,
                         "thresholds": {"mode": "absolute", "steps": [
                             {"color": "green", "value": None}, {"color": "orange", "value": 0.8},
                             {"color": "red", "value": 0.95}]}}, "overrides": []},
         "options": {"orientation": "horizontal", "displayMode": "gradient",
                     "reduceOptions": {"calcs": ["lastNotNull"]}},
         "targets": [{"refId": "A", "expr": expr, "legendFormat": legend, "datasource": PROM}]}
    if desc:
        p["description"] = desc
    return p


def table(title, expr, desc=None, rename=None):
    p = {"type": "table", "title": title, "datasource": PROM,
         "targets": [{"refId": "A", "expr": expr, "format": "table", "instant": True, "datasource": PROM}],
         "transformations": [{"id": "organize", "options": {"excludeByName": {"Time": True},
                                                            "renameByName": rename or {}}}]}
    if desc:
        p["description"] = desc
    return p


def logs(title, expr):
    return {"type": "logs", "title": title, "datasource": LOKI,
            "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending"},
            "targets": [{"refId": "A", "expr": expr, "datasource": LOKI}]}


# ------------------------------------------------------------------ tenant
def tenant_overview():
    b = Board("tenant-overview", "Tenant overview", ["midori", "tenant"])
    vns = {"type": "query", "name": "vnamespace", "label": "Namespace", "datasource": PROM,
           "query": {"query": 'label_values(kube_pod_labels{label_vcluster_loft_sh_namespace!=""}, label_vcluster_loft_sh_namespace)',
                     "refId": "v"},
           "includeAll": True, "multi": True, "current": {"text": "All", "value": "$__all"}, "refresh": 2}
    sel = ('* on (namespace, pod) group_left () max by (namespace, pod) '
           '(kube_pod_labels{label_vcluster_loft_sh_namespace=~"$vnamespace"})')
    b.row("Quota (set by the platform; your hard limits)")
    b.add([(12, bargauge("Quota used", 'kube_resourcequota{type="used"} / on (resource) kube_resourcequota{type="hard"}',
                         "{{resource}}", desc="Share of each ResourceQuota line in use. GPU lines are whole devices "
                         "(nvidia.com/gpu) and MiB of GPU memory (nvidia.com/gpumem).")),
           (12, table("Quota, raw", 'max by (resource, type) (kube_resourcequota)',
                      desc="type=hard is the limit, type=used the current sum."))], h=9)
    b.row("Workloads (by your own pod names)")
    b.add([(12, ts("CPU", [(f'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{{container="", pod!=""}}[5m])) {VPOD} {sel}',
                            "{{vpod}}")], unit="cores", stack=True,
                   desc="Per pod: a gVisor sandbox is one cgroup, so there is no per-container split.")),
           (12, ts("Memory (working set)", [(f'sum by (namespace, pod) (container_memory_working_set_bytes{{container="", pod!=""}}) {VPOD} {sel}',
                                            "{{vpod}}")], unit="bytes", stack=True))])
    b.add([(12, ts("Container restarts (last 1h)", [(f'sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])) {VPOD} {sel}',
                                                    "{{vpod}}")])),
           (12, table("Pods not running", f'(sum by (namespace, pod, phase) (kube_pod_status_phase{{phase!~"Running|Succeeded"}}) > 0) {VPOD} {sel}',
                      rename={"vpod": "pod (yours)", "pod": "pod (host)"}))])
    b.row("GPU (your slices; the card itself is shared and not shown)")
    b.add([(8, ts("GPU memory slice", [(f'tenant:gpu_slice_mib {VPOD}', "{{vpod}}")], unit="decmbytes",
                  desc="nvidia.com/gpumem per pod: the sandbox sees exactly this much GPU memory, and "
                       "allocations past it are refused by gVisor.")),
           (8, ts("GPU time weight", [(f'tenant:gpu_weight {VPOD}', "{{vpod}}")],
                  desc="nvidia.com/gpucores per pod: its share of GPU time against neighbours on the same card, "
                       "re-divided every period; an idle neighbour costs you nothing.")),
           (8, stat("Devices held", 'sum(kube_pod_container_resource_limits{resource="nvidia_com_gpu"})', legend="GPUs"))])
    b.row("Network (Cilium)")
    b.add([(12, ts("Dropped packets from your pods", [('tenant:network_drops:rate5m', "{{reason}} {{protocol}}")], unit="pps",
                   desc="POLICY_DENY to the internet is expected: tenant egress outside the cluster is blocked by design.")),
           (12, ts("Policy denials", [('tenant:policy_denied:rate5m', "{{direction}}")], unit="pps",
                   desc="Ingress denials do not say who was denied."))])
    b.row("Logs")
    b.add([(24, logs("Logs", '{vnamespace=~"${vnamespace:regex}"}'))], h=12)
    return b.json([vns])


def tenant_serving():
    b = Board("tenant-serving", "Model serving (vLLM)", ["midori", "tenant", "vllm"])
    b.row("Load")
    b.add([(8, ts("Requests running / waiting", [('sum by (model_name) (vllm:num_requests_running)', "running {{model_name}}"),
                                                ('sum by (model_name) (vllm:num_requests_waiting)', "waiting {{model_name}}")])),
           (8, ts("KV cache usage", [('max by (model_name) (vllm:kv_cache_usage_perc)', "{{model_name}}")], unit="percentunit",
                  desc="Of the KV cache vLLM sized against its GPU memory SLICE, not the whole card.")),
           (8, ts("Requests finished", [('sum by (model_name, finished_reason) (rate(vllm:request_success_total[5m]))',
                                         "{{model_name}} {{finished_reason}}")], unit="reqps"))])
    b.row("Latency")
    b.add([(12, ts("Time to first token", [
               ('histogram_quantile(0.5, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m])))', "p50 {{model_name}}"),
               ('histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m])))', "p95 {{model_name}}")], unit="s")),
           (12, ts("End-to-end request latency", [
               ('histogram_quantile(0.5, sum by (le, model_name) (rate(vllm:e2e_request_latency_seconds_bucket[5m])))', "p50 {{model_name}}"),
               ('histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:e2e_request_latency_seconds_bucket[5m])))', "p95 {{model_name}}")], unit="s"))])
    b.row("Throughput")
    b.add([(12, ts("Tokens per second", [('sum by (model_name) (rate(vllm:generation_tokens_total[5m]))', "generated {{model_name}}"),
                                         ('sum by (model_name) (rate(vllm:prompt_tokens_total[5m]))', "prompt {{model_name}}")])),
           (12, ts("Prefix cache hit rate", [('sum by (model_name) (rate(vllm:prefix_cache_hits_total[5m])) / sum by (model_name) (rate(vllm:prefix_cache_queries_total[5m]))',
                                             "{{model_name}}")], unit="percentunit"))])
    return b.json()


# ------------------------------------------------------------------- admin
def admin():
    b = Board("midori-admin", "midori: GPU slicing and platform", ["midori", "admin"])
    red = [{"color": "green", "value": None}, {"color": "red", "value": 1}]
    b.row("Things that fail closed or silently")
    b.add([(4, stat("Broker table_full (10m)", 'sum(increase(gpusched_table_full_total[10m]))', thresholds=red,
                    desc="> 0: the driver broker ran out of group slots and time-slicing is NOT enforced for new contexts.")),
           (4, stat("Broker refused/failed (10m)", 'sum(increase(gpusched_refused_total[10m]) + increase(gpusched_cmds_failed_total[10m]))', thresholds=red)),
           (4, stat("runsc-gpu-scheduler down", 'count(midori_systemd_unit_active{unit="runsc-gpu-scheduler"} == 0) or vector(0)', thresholds=red,
                    desc="Fail-closed: no GPU pod starts on a node whose scheduler is down.")),
           (4, stat("Quota webhook ready", 'sum(kube_deployment_status_replicas_available{namespace="e2e", deployment="gvisor-webhook"})',
                    thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}],
                    desc="failurePolicy Fail: 0 means no pod can be created in any tenant.")),
           (4, stat("S3 gateway ready", 'sum(kube_deployment_status_replicas_available{namespace="s3-gateway"})',
                    thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}])),
           (4, stat("Firing alerts", 'count(ALERTS{alertstate="firing", alertname!="Watchdog"}) or vector(0)',
                    thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1}]))], h=5)
    b.row("GPUs (physical)")
    b.add([(8, ts("GPU memory used", [('DCGM_FI_DEV_FB_USED', "{{Hostname}} gpu{{gpu}}")], unit="decmbytes")),
           (8, ts("GPU utilisation", [('DCGM_FI_DEV_GPU_UTIL', "{{Hostname}} gpu{{gpu}}")], unit="percent")),
           (8, ts("Power", [('DCGM_FI_DEV_POWER_USAGE', "{{Hostname}} gpu{{gpu}}")], unit="watt"))])
    b.add([(8, ts("Broker commands / s", [('sum by (instance) (rate(gpusched_cmds_ok_total[5m]))', "ok {{instance}}"),
                                          ('sum by (instance) (rate(gpusched_cmds_failed_total[5m]))', "failed {{instance}}"),
                                          ('sum by (instance) (rate(gpusched_restarts_teardown_total[5m]))', "teardown restarts {{instance}}")])),
           (8, ts("Sandboxes per GPU (broker)", [('gpusched_sandboxes', "{{instance}} {{pci}}")])),
           (8, ts("GPU memory sliced out, by tenant", [('sum by (namespace) (tenant:gpu_slice_mib)', "{{namespace}}")],
                  unit="decmbytes", stack=True, desc="Sum of nvidia.com/gpumem limits; compare with physical use above."))])
    b.row("Tenants")
    b.add([(12, table("Quota use by tenant",
                      'max by (namespace, resource) (kube_resourcequota{type="used", namespace=~"tenant-.+"}) / on (namespace, resource) max by (namespace, resource) (kube_resourcequota{type="hard", namespace=~"tenant-.+"})',
                      rename={"Value": "used / hard"})),
           (12, ts("Tenant memory (all pods)", [('sum by (namespace) (container_memory_working_set_bytes{container="", pod!="", namespace=~"tenant-.+"})', "{{namespace}}")],
                   unit="bytes", stack=True))])
    b.add([(12, ts("Cilium drops by source", [('sum by (source, reason) (rate(hubble_drop_total[5m]))', "{{source}} {{reason}}")], unit="pps")),
           (12, ts("vCluster control-plane restarts (1h)", [('sum by (namespace) (increase(kube_pod_container_status_restarts_total{pod=~"tenant-.+-0"}[1h]))', "{{namespace}}")]))])
    b.row("Nodes")
    b.add([(12, ts("Memory available", [('node_memory_MemAvailable_bytes', "{{instance}}")], unit="bytes")),
           (12, ts("Root filesystem free", [('node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}', "{{instance}}")], unit="percentunit"))])
    return b.json()


for name, fn in [("tenant-overview", tenant_overview), ("tenant-serving", tenant_serving), ("admin-midori", admin)]:
    with open(os.path.join(HERE, name + ".json"), "w") as f:
        json.dump(fn(), f, indent=1)
    print("wrote", name + ".json")
