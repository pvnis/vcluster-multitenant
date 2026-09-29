# GPU probe for gVisor/nvproxy tests on the B300 node.
# MODE=info|matmul|p2p|nccl|all   SECONDS_=duration for matmul
import os, sys, time, json
import torch
mode = os.environ.get("MODE", "all")
dur = float(os.environ.get("SECONDS_", "10"))

def info():
    n = torch.cuda.device_count()
    out = {"devices": n, "visible": os.environ.get("NVIDIA_VISIBLE_DEVICES"), "per_device": []}
    for i in range(n):
        free, total = torch.cuda.mem_get_info(i)
        p = torch.cuda.get_device_properties(i)
        out["per_device"].append({"i": i, "name": p.name, "sms": p.multi_processor_count,
                                  "total_mib": total >> 20, "free_mib": free >> 20})
    print("INFO", json.dumps(out), flush=True)
    return n

def matmul(devs):
    import threading
    res = {}
    def run(d):
        torch.cuda.set_device(d)
        a = torch.randn(8192, 8192, device=d, dtype=torch.bfloat16); b = torch.randn_like(a)
        for _ in range(5): a @ b
        torch.cuda.synchronize(d)
        n, t0 = 0, time.time()
        while time.time() - t0 < dur:
            for _ in range(20): a @ b
            torch.cuda.synchronize(d); n += 20
        el = time.time() - t0
        res[d] = round(2 * 8192**3 * n / el / 1e12, 1)
    ts = [threading.Thread(target=run, args=(d,)) for d in devs]
    [t.start() for t in ts]; [t.join() for t in ts]
    print("MATMUL_TFLOPS", json.dumps(res), "total", round(sum(res.values()), 1), flush=True)

def p2p(n):
    if n < 2: print("P2P skipped (1 device)"); return
    can = {f"{i}->{j}": torch.cuda.can_device_access_peer(i, j) for i in range(n) for j in range(n) if i != j}
    print("P2P_ACCESS", json.dumps(can), flush=True)
    x = torch.empty(1 << 30, dtype=torch.uint8, device=0)  # 1 GiB
    for j in range(1, n):
        y = torch.empty_like(x, device=j)
        for _ in range(3): y.copy_(x)
        torch.cuda.synchronize(0); torch.cuda.synchronize(j)
        t0 = time.time()
        for _ in range(10): y.copy_(x)
        torch.cuda.synchronize(0); torch.cuda.synchronize(j)
        print(f"P2P_COPY 0->{j} {10 * 1.0 / (time.time() - t0):.1f} GiB/s", flush=True)

def nccl_worker(rank, world):
    import torch.distributed as dist
    os.environ.setdefault("MASTER_ADDR", "127.0.0.1"); os.environ.setdefault("MASTER_PORT", "29511")
    torch.cuda.set_device(rank)
    dist.init_process_group("nccl", rank=rank, world_size=world, device_id=torch.device(f"cuda:{rank}"))
    x = torch.ones(256 << 20, dtype=torch.bfloat16, device=rank)  # 512 MiB
    for _ in range(5): dist.all_reduce(x)
    torch.cuda.synchronize()
    it, t0 = 20, time.time()
    for _ in range(it): dist.all_reduce(x)
    torch.cuda.synchronize(); el = time.time() - t0
    size = x.numel() * x.element_size()
    busbw = size * 2 * (world - 1) / world * it / el / 1e9
    if rank == 0:
        print(f"NCCL_ALLREDUCE world={world} size=512MiB busbw={busbw:.1f} GB/s ok={bool(x[0].item() > 0)}", flush=True)
    dist.destroy_process_group()

if __name__ == "__main__":
    n = info()
    if mode in ("matmul", "all"): matmul(list(range(n)))
    if mode in ("p2p", "all"): p2p(n)
    if mode in ("nccl", "all") and n > 1:
        import torch.multiprocessing as mp
        mp.spawn(nccl_worker, args=(n,), nprocs=n, join=True)
    if mode == "hold":
        time.sleep(1e9)
    print("DONE", flush=True)
