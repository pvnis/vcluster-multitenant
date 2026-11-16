#!/bin/bash
# Assemble an amdgpu DKMS source tree from a ROCm amdgpu git checkout,
# following drivers/gpu/drm/amd/dkms/sources.
set -euo pipefail
SRC=$1; DST=$2
mkdir -p "$DST"
grep -vE '^\s*(#|$)' "$SRC/drivers/gpu/drm/amd/dkms/sources" | while read -r s d; do
  if [[ "$d" == */ || "$d" == . ]]; then
    mkdir -p "$DST/$d"; cp -a "$SRC/$s" "$DST/$d"
  else
    mkdir -p "$DST/$(dirname "$d")"; cp -a "$SRC/$s" "$DST/$d"
  fi
done
cp "$DST/amd/dkms/Makefile" "$DST/Makefile"
cp "$DST/amd/dkms/dkms.conf" "$DST/dkms.conf"
(cd "$DST/amd/dkms" && ./autogen.sh >/dev/null 2>&1)
