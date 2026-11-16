// Launches a kernel (user queue + doorbell), fills/reads back VRAM, reports
// the VRAM the process can see (the Sentry's quota if one is set).
#include <hip/hip_runtime.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
__global__ void add(const float* a, const float* b, float* c, size_t n) {
  size_t i = blockIdx.x * (size_t)blockDim.x + threadIdx.x;
  if (i < n) c[i] = a[i] + b[i];
}
#define CK(x) do { hipError_t e = (x); if (e != hipSuccess) { \
  printf("FAIL %s: %s\n", #x, hipGetErrorString(e)); return 1; } } while (0)
int main(int argc, char** argv) {
  size_t n = (argc > 1 ? atol(argv[1]) : 64) << 18;  // MiB of floats per buffer
  int iters = argc > 2 ? atoi(argv[2]) : 100;
  int ndev; CK(hipGetDeviceCount(&ndev));
  hipDeviceProp_t p; CK(hipGetDeviceProperties(&p, 0));
  size_t fr, tot; CK(hipMemGetInfo(&fr, &tot));
  printf("devices=%d name=%s arch=%s CUs=%d vram_total=%zu MiB free=%zu MiB\n",
         ndev, p.name, p.gcnArchName, p.multiProcessorCount, tot >> 20, fr >> 20);
  std::vector<float> a(n), b(n), c(n);
  for (size_t i = 0; i < n; i++) { a[i] = i; b[i] = 2.0f * i; }
  float *da, *db, *dc;
  CK(hipMalloc(&da, n * 4)); CK(hipMalloc(&db, n * 4)); CK(hipMalloc(&dc, n * 4));
  CK(hipMemcpy(da, a.data(), n * 4, hipMemcpyHostToDevice));
  CK(hipMemcpy(db, b.data(), n * 4, hipMemcpyHostToDevice));
  CK(hipMemset(dc, 0, n * 4));
  for (int it = 0; it < iters; it++) add<<<(n + 255) / 256, 256>>>(da, db, dc, n);
  CK(hipGetLastError()); CK(hipDeviceSynchronize());
  CK(hipMemcpy(c.data(), dc, n * 4, hipMemcpyDeviceToHost));
  size_t bad = 0; for (size_t i = 0; i < n; i++) if (c[i] != 3.0f * i) bad++;
  printf("vecadd %zu MiB x3, %d launches: %s (%zu mismatches)\n", (n * 4) >> 20, iters,
         bad ? "FAIL" : "PASS", bad);
  return bad ? 1 : 0;
}
