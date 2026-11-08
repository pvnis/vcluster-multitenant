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
  float a = out[idx], b = 1.00000119f, c = 0.99999881f;
  #pragma unroll 128
  for (int i = 0; i < inner; ++i) a = fmaf(a, b, c);
  out[idx] = a;                 // write-back so the loop isn't optimized away
}

int main() {
  const int N = 1 << 20;        // threads (4 MiB of float state)
  const int inner = 4096;       // FMAs/thread/launch
  const int threads = 256, blocks = N / threads;
  float* d; cudaMalloc(&d, N * sizeof(float)); cudaMemset(d, 0, N * sizeof(float));
  const double flop_per_launch = (double)N * inner * 2.0;   // 2 FLOP per FMA
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
