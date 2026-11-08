#!/usr/bin/env bash
# GHOST-scheduling overhead sweep. Scales overhead-bench N = 1,2,4,8,16, and at
# each N (after warmup) collects the summed cuBLAS throughput across all slices
# plus the broker command rate. Writes ~/overhead-out/{overhead.csv,raw-N.txt}.
#   Run AFTER: kubectl apply -f .../overhead-bench.yaml  (N=1 Running, printing TFLOPS)
#   bash ~/vcluster-multitenant/manifests/midori/tests/collect-overhead.sh
set -u
NS=gpu-test; DEP=overhead-bench
NODE_IP=${NODE_IP:-10.30.30.54}   # test node's IP, for its broker (gpusched) metrics
OUT=$HOME/overhead-out; mkdir -p "$OUT"
CSV=$OUT/overhead.csv; [ -f "$CSV" ] || echo "N,R_total_tflops,per_slice_tflops,broker_cmds_per_s" > "$CSV"

running_pods() { kubectl -n $NS get pods -l app=$DEP --field-selector=status.phase=Running -o name 2>/dev/null; }

sum_tflops() {   # sum each running pod's most-recent TFLOPS line
  local s=0 v
  for po in $(running_pods); do
    v=$(kubectl -n $NS logs "$po" --tail=1 2>/dev/null | grep -oE 'TFLOPS=[0-9.]+' | tail -1 | cut -d= -f2)
    [ -n "$v" ] && s=$(python3 -c "print($s+$v)")
  done
  echo "$s"
}

broker_cmds() {  # broker cmds/s on nv-1 (10.30.30.54), via a short-lived port-forward
  kubectl -n observability port-forward svc/kps-kube-prometheus-stack-prometheus 9091:9090 >/dev/null 2>&1 &
  local pf=$!; sleep 3
  local q="sum(rate(gpusched_cmds_ok_total{instance=~\"${NODE_IP}.*\"}[1m]))"
  local r; r=$(curl -sG http://localhost:9091/api/v1/query --data-urlencode "query=$q" \
      | python3 -c "import sys,json;d=json.load(sys.stdin)['data']['result'];print(round(float(d[0]['value'][1]),1) if d else 'NA')" 2>/dev/null)
  kill $pf 2>/dev/null; echo "${r:-NA}"
}

for N in ${@:-1 2 4 8 16}; do
  echo "=== N=$N ==="
  kubectl -n $NS scale deploy/$DEP --replicas=$N >/dev/null
  prev=-1; stab=0   # wait for a SETTLED count: exactly N running + none terminating,
  for i in $(seq 1 90); do   # or a stable count below N (can't fit more)
    R=$(running_pods | wc -l)
    T=$(kubectl -n $NS get pods -l app=$DEP --no-headers 2>/dev/null | grep -c Terminating)
    { [ "$R" -eq "$N" ] && [ "$T" -eq 0 ]; } && break
    if [ "$R" -eq "$prev" ] && [ "$T" -eq 0 ]; then stab=$((stab+1)); else stab=0; fi
    [ "$stab" -ge 6 ] && break
    prev=$R; sleep 5
  done
  echo "  $(running_pods | wc -l)/$N running; warmup 45s"; sleep 45
  raw=$OUT/raw-$N.txt; : > "$raw"
  for k in $(seq 1 10); do echo "$(sum_tflops)" >> "$raw"; sleep 3; done   # ~30s of samples
  med=$(python3 -c "import statistics as s;xs=[float(x) for x in open('$raw') if x.strip()];print(round(s.median(xs),1))")
  per=$(python3 -c "print(round($med/$N,1))")
  bc=$(broker_cmds)
  echo "$N,$med,$per,$bc" | tee -a "$CSV"
done
echo "=== done ->"; cat "$CSV"
