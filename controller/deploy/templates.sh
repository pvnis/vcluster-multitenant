#!/bin/bash
# Builds the tenant-templates ConfigMap from the runbook's own manifests, so
# the controller renders exactly what the runbook applies. Re-run after
# changing any of them, then restart the controller.
#   deploy/templates.sh | kubectl apply -f -
set -euo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
kubectl create configmap tenant-templates -n tenant-system --dry-run=client -o yaml \
  --from-file=tenant-quota.yaml="$R/manifests/midori/tenant-quota.yaml" \
  --from-file=tenant-netpol.yaml="$R/manifests/midori/tenant-netpol.yaml" \
  --from-file=tenant-floor.yaml="$R/manifests/cilium/tenant-floor.yaml" \
  --from-file=tenant-internet.yaml="$R/manifests/midori/tenant-internet.yaml" \
  --from-file=tenant-allow.yaml="$R/manifests/cilium/tenant-allow.yaml" \
  --from-file=tenant-s3-allow.yaml="$R/manifests/midori/tenant-s3-allow.yaml" \
  --from-file=tenant-scrape-allow.yaml="$R/manifests/midori/observability/tenant-scrape-allow.yaml" \
  --from-file=tenant-prom-proxy.yaml="$R/manifests/midori/observability/tenant-prom-proxy.yaml" \
  --from-file=gateway-ingress.yaml="$R/manifests/midori/phoenix/gateway-ingress.yaml" \
  --from-file=vcluster-tenant.yaml="$R/values/tenant.yaml" \
  --from-file=vcluster-nv-tenant.yaml="$R/values/nv-tenant.yaml" \
  --from-file=vcluster-midori-tenant.yaml="$R/values/midori-tenant.yaml" \
  --from-file=dashboard-tenant-overview.json="$R/manifests/midori/observability/dashboards/tenant-overview.json" \
  --from-file=dashboard-tenant-serving.json="$R/manifests/midori/observability/dashboards/tenant-serving.json"
