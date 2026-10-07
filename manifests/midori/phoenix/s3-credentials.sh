#!/bin/bash
# Gives KServe's storage-initializer in tenant-phoenix its S3 gateway key.
#
#   KUBECONFIG=~/tenants/tenant-phoenix.kubeconfig \
#     ./s3-credentials.sh ~/midori-build/s3keys/tenant-phoenix
#
# The key file holds "<access-key>,<secret>", the tenant-phoenix half of
# --auth-key on s3-gateway.yaml. KServe's credential builder reads S3 settings
# from the annotations of Secrets listed on the pod's ServiceAccount, so the
# Secret is attached to inference-serving's `default` SA, the one the
# LLMInferenceService pods run as.
set -euo pipefail
NS=${NS:-inference-serving}
IFS=, read -r AK SK < "$1"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" apply -f - <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: s3-gateway
  annotations:
    serving.kserve.io/s3-endpoint: s3-gateway.s3-gateway.svc.cluster.local:8080
    serving.kserve.io/s3-usehttps: "0"
    serving.kserve.io/s3-region: us-east-1
    serving.kserve.io/s3-usevirtualbucket: "false"
    serving.kserve.io/s3-useanoncredential: "false"
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "$AK"
  AWS_SECRET_ACCESS_KEY: "$SK"
YAML
kubectl -n "$NS" patch serviceaccount default --type merge -p '{"secrets":[{"name":"s3-gateway"}]}'
