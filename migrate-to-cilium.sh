#!/usr/bin/env bash
#
# Replace k3s's flannel + kube-router with Cilium, configured for gVisor.
#
#   sudo bash migrate-to-cilium.sh
#
# DISRUPTIVE. Between the k3s restart and the Cilium install the cluster has no
# CNI and no service networking: every pod is down and every tenant API server
# is unreachable. Budget a few minutes.
#
# Rollback is at the bottom of this file.
#
# Design and rationale: CILIUM-DESIGN.md

set -euo pipefail

KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export KUBECONFIG

POD_CIDR=10.42.0.0/16
NODE_IP=192.168.0.198
CILIUM_VERSION=1.19.5

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --------------------------------------------------------------------------
say "Preflight"

[[ $EUID -eq 0 ]] || { echo "must run as root"; exit 1; }
command -v cilium  >/dev/null || { echo "cilium CLI not found"; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl not found"; exit 1; }

# Refuse to run twice. Re-running after a partial failure needs a human to look
# at what actually landed, not a blind retry.
if [[ -f /etc/rancher/k3s/config.yaml ]] && grep -q flannel-backend /etc/rancher/k3s/config.yaml; then
    echo "config.yaml already carries flannel-backend; migration appears done."
    echo "Inspect the cluster rather than re-running this."
    exit 1
fi

kubectl get nodes >/dev/null || { echo "cluster not reachable"; exit 1; }
echo "cluster reachable, proceeding"

# --------------------------------------------------------------------------
say "Writing /etc/rancher/k3s/config.yaml"

# k3s merges this with the flags already on the unit's ExecStart, so the systemd
# unit is left alone.
#
#   flannel-backend: none      stop k3s deploying flannel
#   disable-network-policy     stop k3s deploying kube-router's netpol controller
#   disable-kube-proxy         Cilium replaces it (see egress-selector-mode below)
#   egress-selector-mode       MANDATORY with disable-kube-proxy. The default
#                              'agent' mode needs kube-proxy for service-endpoint
#                              access, so leaving it breaks `kubectl logs` and
#                              `kubectl exec` -- the tenant-facing kubelet path.
#                              'pod' is unsuitable: Cilium's cluster-pool IPAM
#                              does not allocate from node.spec.podCIDR.
install -Dm644 /dev/stdin /etc/rancher/k3s/config.yaml <<'EOF'
flannel-backend: none
disable-network-policy: true
disable-kube-proxy: true
egress-selector-mode: cluster
EOF
cat /etc/rancher/k3s/config.yaml

# --------------------------------------------------------------------------
say "Restarting k3s (cluster goes down here)"

systemctl restart k3s

for i in $(seq 1 60); do
    if kubectl get --raw /readyz >/dev/null 2>&1; then break; fi
    sleep 5
done
kubectl get --raw /readyz >/dev/null || { echo "API server did not come back"; exit 1; }
echo "API server is back"

# --------------------------------------------------------------------------
say "Clearing flannel remnants"

# Left in place these actively conflict: containerd would keep finding the
# flannel conflist, and the old bridge still holds addresses from the same
# range Cilium is about to hand out.
rm -f /var/lib/rancher/k3s/agent/etc/cni/net.d/10-flannel.conflist
ip link delete cni0      2>/dev/null || true
ip link delete flannel.1 2>/dev/null || true
echo "flannel conflist and interfaces removed"

# --------------------------------------------------------------------------
say "Installing Cilium ${CILIUM_VERSION}"

# socketLB.hostNamespaceOnly is THE gVisor setting. Cilium's default kube-proxy
# replacement rewrites service addresses in a cgroup-attached hook on connect()
# and sendmsg(). A gVisor pod never issues those syscalls on the host -- the
# Sentry implements TCP in userspace and puts finished packets on the veth -- so
# the hook never fires and ClusterIP resolution silently fails for every
# sandboxed pod. This falls back to the tc load-balancer at the veth, which does
# see gVisor's packets. Cilium documents gVisor by name here, alongside Kata and
# KubeVirt.
#
# k8sServiceHost/Port are required under kube-proxy replacement: with no
# kube-proxy, the agent cannot reach the API server via the `kubernetes` service
# that it is itself responsible for programming.
# cni.confPath / cni.binPath are NOT optional on k3s, and getting this wrong
# fails in a way that looks like something else entirely.
#
# k3s does not use the CNI defaults. Its containerd is configured with
#   conf_dir = /var/lib/rancher/k3s/agent/etc/cni/net.d
#   bin_dirs = [/var/lib/rancher/k3s/data/cni]
# whereas Cilium installs to /etc/cni/net.d and /opt/cni/bin. Left at the
# defaults, Cilium comes up perfectly healthy -- agent OK, operator OK,
# kube-proxy replacement active -- while the kubelet never finds a CNI config
# and reports:
#
#   NetworkReady=false reason:NetworkPluginNotReady
#   message:Network plugin returns error: cni plugin not initialized
#
# The node then goes NotReady, takes a node.kubernetes.io/not-ready:NoSchedule
# taint, and every pod including Cilium's own Hubble Relay sits Pending with
# "untolerated taint". The visible symptom points at scheduling; the cause is a
# path mismatch.
cilium install --version "${CILIUM_VERSION}" \
    --set ipam.operator.clusterPoolIPv4PodCIDRList="${POD_CIDR}" \
    --set kubeProxyReplacement=true \
    --set k8sServiceHost="${NODE_IP}" \
    --set k8sServicePort=6443 \
    --set socketLB.hostNamespaceOnly=true \
    --set bpf.masquerade=true \
    --set cni.confPath=/var/lib/rancher/k3s/agent/etc/cni/net.d \
    --set cni.binPath=/var/lib/rancher/k3s/data/cni \
    --set hubble.enabled=true \
    --set hubble.relay.enabled=true

say "Waiting for Cilium"
cilium status --wait

# --------------------------------------------------------------------------
say "Recycling pods onto Cilium networking"

# Pods that survived the restart still hold flannel IPs and are not known to
# Cilium's ipcache, so policy would not apply to them. Deleting them is the
# supported way to re-IP: everything here is managed by a controller.
kubectl delete pods --all -n kube-system --ignore-not-found
for ns in tenant-a tenant-b; do
    kubectl delete pods --all -n "$ns" --ignore-not-found || true
done

# --------------------------------------------------------------------------
say "Result"

kubectl get nodes -o wide
kubectl get pods -A -o wide
cilium status

cat <<'EOF'

Next, and NOT done by this script:

  1. Label the tenant namespaces, which every Cilium policy selector keys on:
       kubectl label ns tenant-a tenant=tenant-a
       kubectl label ns tenant-b tenant=tenant-b

  2. Remove the old kube-router-era policies, now superseded:
       kubectl -n tenant-a delete netpol default-deny-ingress allow-same-tenant
       kubectl -n tenant-b delete netpol default-deny-ingress allow-same-tenant

  3. Apply the floor and the allow list, per tenant:
       for t in tenant-a tenant-b; do
         sed "s/TENANT/$t/g" manifests/cilium/tenant-floor.yaml | kubectl apply -f -
         sed "s/TENANT/$t/g" manifests/cilium/tenant-allow.yaml | kubectl apply -f -
       done

  4. Roll out the vCluster change that lets tenant NetworkPolicies reach the
     host (values/tenant.yaml, sync.toHost.networkPolicies):
       vcluster create tenant-a -n tenant-a --upgrade \
         -f values/tenant.yaml -f values/tenant-a.yaml
       vcluster create tenant-b -n tenant-b --upgrade \
         -f values/tenant.yaml -f values/tenant-b.yaml

  5. Run the test plan in CILIUM-DESIGN.md. Every reachability probe must be a
     retry loop over 60s or more -- one-shot probe pods produced two false
     "blocked" results under kube-router and will do it again.

Rollback:
  rm /etc/rancher/k3s/config.yaml
  cp backup-20260810-100812/10-flannel.conflist \
     /var/lib/rancher/k3s/agent/etc/cni/net.d/
  cilium uninstall || true
  systemctl restart k3s
EOF
