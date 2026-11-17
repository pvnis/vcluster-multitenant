// Minimal compute-bound GPU bench: a sustained FMA loop, no cuBLAS, no runtime
// framework. Replaces the pytorch container (~690 MiB host, ~1 GiB VRAM/context)
// with a tiny binary (~150 MiB host, ~0.4-0.6 GiB VRAM/context) so many more
// slices fit per node and per GPU. Prints "TFLOPS=<x>" every ~2s, same format
// collect-overhead.sh already parses.
#include <cstdio>
#include <chrono>
#include <cuda_runtime.h>

__global__ void fma_loop(float* out, int inner) {
  int idx = blockIdx.x * blockDim.x + threadIdx.x;
  float b = 1.00000119f, c = 0.99999881f;
  // 8 INDEPENDENT accumulators → enough ILP to hide FMA latency and saturate the
  // ALUs (a single dependent chain is latency-bound and leaves the GPU ~idle).
  float a0=out[idx], a1=a0+1, a2=a0+2, a3=a0+3, a4=a0+4, a5=a0+5, a6=a0+6, a7=a0+7;
  #pragma unroll 32
  for (int i = 0; i < inner; ++i) {
    a0=fmaf(a0,b,c); a1=fmaf(a1,b,c); a2=fmaf(a2,b,c); a3=fmaf(a3,b,c);
    a4=fmaf(a4,b,c); a5=fmaf(a5,b,c); a6=fmaf(a6,b,c); a7=fmaf(a7,b,c);
  }
  out[idx] = a0+a1+a2+a3+a4+a5+a6+a7;   // write-back so nothing is optimized away
}

int main() {
  const int N = 1 << 20;        // threads (4 MiB of float state)
  const int inner = 4096;       // FMAs/thread/launch
  const int threads = 256, blocks = N / threads;
  float* d; cudaMalloc(&d, N * sizeof(float)); cudaMemset(d, 0, N * sizeof(float));
  const double flop_per_launch = (double)N * inner * 8 * 2.0;   // 8 chains x 2 FLOP/FMA
  long launches = 0;
  auto t = std::chrono::steady_clock::now();
  for (;;) {
    fma_loop<<<blocks, threads>>>(d, inner);
    if (++launches % 50 == 0) {
      cudaDeviceSynchronize();
      double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t).count();
      if (dt >= 2.0) {
        printf("TFLOPS=%.1f\n", flop_per_launch * launches / dt / 1e12);
        fflush(stdout);
        t = std::chrono::steady_clock::now();
        launches = 0;
      }
    }
  }
}
