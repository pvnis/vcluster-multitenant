#!/bin/bash
# Create one AMD tenant on the amdvm single-node cluster, with every host-side
# layer the runbooks require, in an order that leaves no unguarded window:
#   ./create-tenant.sh tenant-amd-a 31543 576
#   ./create-tenant.sh tenant-amd-b 31643 576
# args: <name> <api NodePort> <VRAM units of 512 MiB>
set -euo pipefail
T=$1; PORT=$2; VRAM=$3
R=$(cd "$(dirname "$0")/../.." && pwd)
M=$R/manifests

# 1. Namespace with every label BEFORE anything runs in it:
#    gvisor=   -> the quota webhook fires (unlabelled = silent quota escape)
#    tenant=   -> Cilium floor/allow selectors
#    PSA       -> baseline enforced host-side
kubectl create namespace "$T" --dry-run=client -o yaml | kubectl apply -f -
kubectl label ns "$T" --overwrite gvisor= tenant="$T" \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted

# 2. Quota and network policy before the control plane exists.
sed -e "s/NAMESPACE/$T/" -e "s/VRAM/$VRAM/" "$M/amdvm/tenant-quota.yaml" | kubectl apply -f -
sed "s/NAMESPACE/$T/g" "$M/midori/tenant-netpol.yaml" | kubectl apply -f -
sed "s/TENANT/$T/g" "$M/cilium/tenant-floor.yaml" | kubectl apply -f -
sed "s/TENANT/$T/g" "$M/cilium/tenant-allow.yaml" | kubectl apply -f -

# 3. The virtual cluster. vcluster refuses to run from a directory holding a
#    file named "vcluster", so run from values/.
cat > "/tmp/$T-port.yaml" <<EOF
controlPlane:
  service:
    httpsNodePort: $PORT
EOF
(cd "$R/values" && vcluster create "$T" -n "$T" --connect=false --upgrade \
  --values tenant.yaml --values amd-tenant.yaml --values "/tmp/$T-port.yaml")
rm -f "/tmp/$T-port.yaml"

# 4. Kubeconfig pointing at the NodePort.
"$M/amdvm/tenant-kubeconfig.sh" "$T" "$PORT"
