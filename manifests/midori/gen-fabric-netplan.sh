#!/usr/bin/env bash
# Generate per-node /etc/netplan/60-fabric.yaml into fabric-netplan.d/.
# The fabric vNIC is a BlueField-2 VF whose kernel name is PCI-slot dependent, so
# it can differ per node — it's the per-node variable here alongside the octet.
# ens3 stays the node's primary IP / default route / Cilium dataplane; these
# subinterfaces carry NO default route. Jumbo MTU 9000. Storage → Ceph 10.33.0.0/24
# via the midori-stor gateway 10.100.2.2.
#
# node-exporter currently reports enp5s0 on cp-0/1/2/eye-0 (verify with
# `ip -br link`); nv-0/nv-1/amd-0 have no VF yet → IFACE left as REPLACE-IFACE.
# Re-run this after confirming/attaching to refresh the files.
#   bash gen-fabric-netplan.sh
#   # on each node: sudo cp fabric-netplan.d/60-fabric-<node>.yaml /etc/netplan/60-fabric.yaml
#   #               sudo chmod 600 … ; sudo netplan try ; sudo netplan apply
set -eu
OUT="$(dirname "$0")/fabric-netplan.d"; mkdir -p "$OUT"

gen() {  # node iface octet
  local node="$1" iface="$2" octet="$3" f="$OUT/60-fabric-$1.yaml"
  cat > "$f" <<EOF
# $node — fabric vNIC: $iface, host octet .$octet (same on all three VLANs).
# Install as /etc/netplan/60-fabric.yaml (separate file; leaves ens3 untouched).
# If '$iface' is wrong, check 'ip -br link' and fix the four refs below.
network:
  version: 2
  renderer: networkd
  ethernets:
    $iface: { dhcp4: no, dhcp6: no, accept-ra: no, mtu: 9000 }   # trunk parent, no IP
  vlans:
    $iface.106: { id: 106, link: $iface, mtu: 9000, dhcp4: no, addresses: [10.100.0.$octet/24] }   # midori-bgp (BGP+VIPs)
    $iface.107: { id: 107, link: $iface, mtu: 9000, dhcp4: no, addresses: [10.100.1.$octet/24] }   # midori-internal (idle)
    $iface.108:                                                                                     # midori-storage → CephFS
      id: 108
      link: $iface
      mtu: 9000
      dhcp4: no
      addresses: [10.100.2.$octet/24]           # no DHCP; .2 is the storage gateway
      routes:
        - { to: 10.33.0.0/24, via: 10.100.2.2 }  # Ceph net (mons .61-.63); only route out .108
EOF
  echo "wrote $f  ($iface, .$octet)"
}

#    node    iface          octet
gen  cp-0    enp5s0         100
gen  cp-1    enp5s0         101
gen  cp-2    enp5s0         102
gen  eye-0   enp5s0         10
gen  nv-0    REPLACE-IFACE  110   # VF not attached yet — set IFACE from `ip -br link`
gen  nv-1    REPLACE-IFACE  111
gen  amd-0   REPLACE-IFACE  120
