#!/bin/bash
# (Re)write a tenant's kubeconfig for the node's CURRENT address. The VM's
# address comes from DHCP and changes when the VM is re-created, which leaves
# the old kubeconfigs pointing nowhere.
#   ./tenant-kubeconfig.sh tenant-amd-a 31543
set -euo pipefail
T=$1; PORT=$2
R=$(cd "$(dirname "$0")/../.." && pwd)
NODE_IP=$(kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
mkdir -p "$R/kubeconfigs"
vcluster connect "$T" -n "$T" --print --server "https://$NODE_IP:$PORT" > "$R/kubeconfigs/$T.yaml"
echo "kubeconfig: $R/kubeconfigs/$T.yaml -> https://$NODE_IP:$PORT"
