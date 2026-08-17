#!/usr/bin/env bash
#
# Network isolation tests for the Cilium + gVisor + vCluster setup.
#
#   bash test-isolation.sh
#
# Every probe retries. A "must succeed" probe retries until it works and reports
# how long it took; a "must fail" probe is retried for a full minute and is only
# believed once it has failed for the whole window. That asymmetry is the point:
# a single failed connection proves nothing, because a pod that is merely not
# ready yet fails exactly like a pod that is correctly blocked. Two false
# "cross-tenant blocked" results came from ignoring this.

set -uo pipefail
cd "$(dirname "$0")"

DENY_WINDOW=${DENY_WINDOW:-60}
pass=0; fail=0

kc() { KUBECONFIG=kubeconfigs/$1.yaml kubectl "${@:2}"; }

# Run a probe inside a tenant's client pod.
#
#   0 = connected, 1 = refused/timed out, 2 = the probe never ran
#
# The third case is the one that matters. `kubectl exec` fails for reasons that
# have nothing to do with the network -- the client pod restarting, the API
# server briefly unavailable -- and an exec failure looks identical to a refused
# connection if you only read kubectl's exit status. Scored as "unreachable"
# that silently turns into a PASS on every deny test, which is precisely the
# false result this project has already produced twice by other means.
#
# So the verdict is decided INSIDE the pod and echoed back as a sentinel. If the
# sentinel does not come back, the probe did not run and the caller retries
# rather than drawing a conclusion.
probe() {  # tenant target
    local out
    out=$(kc "$1" exec netprobe-client --request-timeout=15s -- \
              sh -c "wget -T 3 -q -O - '$2' >/dev/null 2>&1 && echo P_OK || echo P_NO" 2>/dev/null)
    case "$out" in
        *P_OK*) return 0 ;;
        *P_NO*) return 1 ;;
        *)      return 2 ;;
    esac
}

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

# Must succeed. Retries for up to 60s, reports seconds to first success.
expect_reachable() {  # tenant target label
    local t0 elapsed rc errs=0
    t0=$(date +%s)
    for _ in $(seq 1 30); do
        probe "$1" "$2"; rc=$?
        case $rc in
            0) elapsed=$(( $(date +%s) - t0 )); ok "$3 (reachable after ${elapsed}s)"; return ;;
            2) errs=$((errs+1)) ;;
        esac
        sleep 2
    done
    bad "$3 (never became reachable in 60s; ${errs} probes failed to run)"
}

# Must fail, for the whole window. One success anywhere in it is a breach.
#
# Probes that failed to run are counted but do NOT count toward the window: a
# deny test that only "passed" because the probe never executed is not evidence
# of anything, so the result is reported as inconclusive rather than a pass.
expect_blocked() {  # tenant target label
    local deadline=$(( $(date +%s) + DENY_WINDOW ))
    local n=0 errs=0 rc
    while [ "$(date +%s)" -lt "$deadline" ]; do
        probe "$1" "$2"; rc=$?
        case $rc in
            0) bad "$3 (REACHABLE after ${n} attempts -- isolation breach)"; return ;;
            1) n=$((n+1)) ;;
            2) errs=$((errs+1)) ;;
        esac
        sleep 2
    done
    if [ "$n" -eq 0 ]; then
        bad "$3 (INCONCLUSIVE -- no probe ever ran, ${errs} exec failures)"
    elif [ "$errs" -gt 0 ]; then
        ok "$3 (blocked, ${n} attempts; ${errs} probes failed to run)"
    else
        ok "$3 (blocked for ${DENY_WINDOW}s, ${n} attempts)"
    fi
}

# --------------------------------------------------------------------------
echo
echo "Resolving pod addresses from the host"
A_SRV=$(kubectl -n tenant-a get pod netprobe-server-x-default-x-tenant-a -o jsonpath='{.status.podIP}')
B_SRV=$(kubectl -n tenant-b get pod netprobe-server-x-default-x-tenant-b -o jsonpath='{.status.podIP}')
echo "  tenant-a server: $A_SRV"
echo "  tenant-b server: $B_SRV"

# --------------------------------------------------------------------------
echo
echo "1. gVisor + Cilium: service resolution through a ClusterIP"
echo "   The socketLB.hostNamespaceOnly test. A sandboxed pod never issues the"
echo "   connect() syscall Cilium's socket LB hooks, so without the fallback"
echo "   this fails while everything else looks fine."
expect_reachable tenant-a "http://netprobe:8080/"        "tenant-a: ClusterIP by DNS name"
expect_reachable tenant-b "http://netprobe:8080/"        "tenant-b: ClusterIP by DNS name"

echo
echo "2. Intra-tenant pod-to-pod"
expect_reachable tenant-a "http://$A_SRV:8080/"          "tenant-a client -> own server by pod IP"
expect_reachable tenant-b "http://$B_SRV:8080/"          "tenant-b client -> own server by pod IP"

echo
echo "3. Cross-tenant (east-west) -- must be blocked, both directions"
expect_blocked  tenant-a "http://$B_SRV:8080/"           "tenant-a client -> tenant-b server"
expect_blocked  tenant-b "http://$A_SRV:8080/"           "tenant-b client -> tenant-a server"

echo
echo "4. North-south egress -- must be blocked"
expect_blocked  tenant-a "http://1.1.1.1/"               "tenant-a -> internet by IP"
expect_blocked  tenant-b "http://1.1.1.1/"               "tenant-b -> internet by IP"

echo
echo "5. Host control plane -- must be blocked"
echo "   The tenant's own workloads must not reach the HOST API server. Its"
echo "   vCluster control plane still must, and does, or the cluster is dead."
expect_blocked  tenant-a "https://10.43.0.1:443/"        "tenant-a workload -> host API server"
expect_blocked  tenant-b "https://10.43.0.1:443/"        "tenant-b workload -> host API server"

# --------------------------------------------------------------------------
echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
