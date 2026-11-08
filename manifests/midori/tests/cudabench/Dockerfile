# Tiny CUDA FMA bench — builds to a single binary on a CUDA runtime base.
# Build + push to the in-cluster registry, then point overhead-bench.yaml at it:
#   docker build -t registry.midori/cudabench:1 manifests/midori/tests/cudabench
#   crane push ... OR docker push  (mirror as the other registry.midori images)
# -arch=sm_86 = RTX A6000 (Ampere GA102). For a B300 add -gencode arch=sm_100.
FROM nvidia/cuda:13.0.0-devel-ubuntu22.04 AS build
COPY bench.cu /bench.cu
# static cudart → the binary needs nothing from the runtime image but libcuda,
# which the GPU runtime injects. Lets us use the tiny "base" image below.
RUN nvcc -O3 -arch=sm_86 --cudart static -o /bench /bench.cu

FROM nvidia/cuda:13.0.0-base-ubuntu22.04
COPY --from=build /bench /bench
ENTRYPOINT ["/bench"]
