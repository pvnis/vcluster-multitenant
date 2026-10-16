#!/bin/bash
# midori-amd-0: base OS and the AMD driver for Navi 48 (gfx1201, RDNA4).
#
# Driver: the in-tree amdgpu of Ubuntu 24.04's HWE kernel (7.0), which supports
# RDNA4, plus AMD's firmware package (ROCm 7.2.4 repo: gfx12 firmware, absent
# from Ubuntu's 2024 linux-firmware). Not ROCm's amdgpu-dkms: 6.16.13 fails to
# build on Ubuntu's 6.8.0-147 ("too few arguments to function
# pci_resize_resource"), and 6.8.0-88 no longer has linux-modules-extra.
# 7.0 has no linux-modules-extra: linux-modules carries every module.
# Phase 1 installs the kernel and reboots; run the script again for phase 2.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
K=7.0.0-38-generic
sudo systemctl disable --now unattended-upgrades || true
sudo apt-get update -q
sudo dpkg --purge amdgpu-dkms 2>/dev/null || true
sudo apt-get install -yq chrony python3 rsync curl jq linux-image-$K linux-headers-$K linux-modules-$K
# An unattended kernel change would leave the GPU on an untested driver.
sudo apt-mark hold linux-image-$K linux-headers-$K linux-modules-$K \
  linux-image-generic linux-headers-generic linux-generic linux-generic-hwe-24.04 || true
if [ "$(uname -r)" != "$K" ]; then echo "REBOOT-INTO-$K"; sudo systemctl reboot; exit 0; fi
V=7.2.4
if ! dpkg -l amdgpu-install >/dev/null 2>&1; then
  DEB=$(curl -fsSL https://repo.radeon.com/amdgpu-install/$V/ubuntu/noble/ | grep -o 'amdgpu-install_[^"]*_all.deb' | head -1)
  curl -fsSLo /tmp/amdgpu-install.deb https://repo.radeon.com/amdgpu-install/$V/ubuntu/noble/$DEB
  sudo apt-get install -yq /tmp/amdgpu-install.deb
  sudo apt-get update -q
fi
sudo apt-get install -yq amdgpu-dkms-firmware rocminfo
echo amdgpu | sudo tee /etc/modules-load.d/amdgpu.conf >/dev/null
sudo modprobe amdgpu
ls -l /dev/kfd /dev/dri/
echo AMD-BASE-DONE
