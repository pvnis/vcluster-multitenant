#!/bin/bash
# Builds the controller image without docker and pushes it to the in-cluster
# registry (../../manifests/midori/registry.yaml), from a node where
# 127.0.0.1:30500 reaches it. Prints the tag.
#
#   image = node:24-alpine (amd64 digest, pinned)
#         + /app       sources and production node_modules (Node runs the .ts
#                      sources directly; there is no build step)
#         + /usr/local/bin/helm   same version as the operator's helm
set -euo pipefail
cd "$(dirname "$0")/.."
REG=${REG:-127.0.0.1:30500}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

mkdir -p "$W/app/app" "$W/helm/usr/local/bin" "$W/dl"
cp -r src package.json package-lock.json "$W/app/app/"
(cd "$W/app/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm package-lock.json)

HV=$(helm version --template '{{.Version}}')
curl -fsSL "https://get.helm.sh/helm-$HV-linux-amd64.tar.gz" | tar xz -C "$W/dl"
install -m 0755 "$W/dl/linux-amd64/helm" "$W/helm/usr/local/bin/helm"
[ -f "$W/helm/usr/local/bin/helm" ] && "$W/helm/usr/local/bin/helm" version --short >&2

tar -C "$W/app" -cf "$W/app.tar" --owner=0 --group=0 app
tar -C "$W/helm" -cf "$W/helm.tar" --owner=0 --group=0 usr

BASE="docker.io/library/node:24-alpine@$(crane digest --platform linux/amd64 docker.io/library/node:24-alpine)"
TAG="$(git rev-parse --short HEAD)-$(cat src/*.ts src/components/*.ts package-lock.json | sha256sum | cut -c1-8)"
IMG="$REG/tenant-controller:$TAG"
crane append --insecure -b "$BASE" -f "$W/app.tar" -f "$W/helm.tar" -t "$IMG" >/dev/null
crane mutate --insecure "$IMG" --entrypoint node --cmd src/main.ts --workdir /app --user node \
  --env HOME=/tmp -t "$IMG" >/dev/null
# The image must hold a helm FILE and the sources; check, do not assume.
crane export --insecure "$IMG" - | tar -tvf - usr/local/bin/helm app/src/main.ts 2>/dev/null | awk '{print $1, $3, $6}' >&2
echo "$TAG"
