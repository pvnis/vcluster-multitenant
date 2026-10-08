#!/bin/sh
# /usr/local/sbin/gpusched-textfile.sh on each GPU node, run every 15 s by
# gpusched-textfile.timer. Turns the GHOST driver broker's state in
# /proc/driver/nvidia/gpusched, and whether the GPU node's own services are
# up, into node-exporter textfile metrics.
#
# The counters matter: `table_full` > 0 is the B300 defect-1 shape, where the
# broker ran out of group slots and GPU time-slicing silently stopped being
# enforced (a 75/25 pair measured 645:644, nothing logged). `refused` and
# `cmds_failed` are the other ways enforcement can quietly lapse.
set -eu
OUT=/var/lib/node_exporter/textfile/gpusched.prom
SRC=/proc/driver/nvidia/gpusched
TMP=$(mktemp "$OUT.XXXXXX")
if [ -r "$SRC" ]; then
  awk '
    /^stats / {
      for (i = 2; i < NF; i += 2) {
        printf "# TYPE gpusched_%s_total counter\ngpusched_%s_total %s\n", $i, $i, $(i+1)
      }
    }
    /^dev / { dev[$2]++; tsgs[$2] += $8 }
    END {
      print "# HELP gpusched_sandboxes Sandbox contexts the broker tracks per GPU."
      print "# TYPE gpusched_sandboxes gauge"
      for (d in dev) printf "gpusched_sandboxes{pci=\"%s\"} %d\n", d, dev[d]
      print "# TYPE gpusched_tsgs gauge"
      for (d in tsgs) printf "gpusched_tsgs{pci=\"%s\"} %d\n", d, tsgs[d]
      print "gpusched_up 1"
    }' "$SRC" > "$TMP"
else
  echo "gpusched_up 0" > "$TMP"
fi
# Unit state, here rather than node-exporter's systemd collector: the default
# containerd AppArmor profile denies its D-Bus connection ("An AppArmor policy
# prevents this sender..."), and loosening AppArmor on a DaemonSet that runs
# on every node is the wrong trade for three booleans.
echo "# TYPE midori_systemd_unit_active gauge" >> "$TMP"
for u in runsc-gpu-scheduler nvidia-persistenced k3s-agent; do
  if systemctl is-active --quiet "$u.service"; then v=1; else v=0; fi
  echo "midori_systemd_unit_active{unit=\"$u\"} $v" >> "$TMP"
done
chmod 644 "$TMP"
mv -f "$TMP" "$OUT"
