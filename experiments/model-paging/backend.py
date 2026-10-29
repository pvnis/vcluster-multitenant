"""Engine backends for the model pager.

The pager (pager.py) is the policy + concurrency control; a Backend is the thing
that actually holds weights in VRAM and runs inference. Two implementations:

  - MockBackend: no GPU. Emulates sleep/wake/infer with modeled latencies and
    tracks *physical* VRAM so tests can assert the pager never oversubscribes.
  - VLLMBackend: real vLLM, one engine per model kept warm, slept/woken via
    sleep(level=1)/wake_up(). GPU-only; imported lazily.

Both are async. The real engine calls are blocking, so VLLMBackend runs them in
a thread pool; MockBackend is async-native.
"""

from __future__ import annotations

import asyncio
import time
from typing import Protocol

from residency import MIB, Model


class Backend(Protocol):
    async def load(self, name: str) -> float: ...     # wake; returns seconds
    async def evict(self, name: str) -> None: ...      # sleep
    async def infer(self, name: str, prompt: str, max_tokens: int): ...


# --------------------------------------------------------------------------
# Mock backend (no GPU) — for tests and for dry-running the daemon anywhere.
# --------------------------------------------------------------------------
class MockBackend:
    """Simulates engines with modeled latencies and tracks physical VRAM.

    Latencies are scaled down by `speedup` so a whole trace runs in seconds of
    wall-clock while preserving the *ratios* (fault vs prefill). Set speedup=1.0
    for real-time behaviour.
    """

    def __init__(self, models, tiers, *, speedup=200.0,
                 prefill_s_per_tok=0.00015, ref_mib=13000.0):
        self.models = {m.name: m for m in models}
        self.tiers = {t.name: t for t in tiers}
        self.speedup = speedup
        self.prefill_s_per_tok = prefill_s_per_tok
        self.ref_mib = ref_mib
        self.resident_mib = 0        # physical VRAM the backend believes it holds
        self.peak_mib = 0
        self.loads = 0               # wake calls that brought a model in
        self.evicts = 0              # sleep calls that pushed a model out
        self._loaded = set()
        self._lock = asyncio.Lock()  # guards the physical counters

    def _fault_s(self, m: Model) -> float:
        return (m.size_mib * MIB) / (self.tiers[m.master_tier].bw_gbps * 1e9)

    async def load(self, name: str) -> float:
        m = self.models[name]
        async with self._lock:
            if name not in self._loaded:
                self._loaded.add(name)
                self.resident_mib += m.size_mib
                self.peak_mib = max(self.peak_mib, self.resident_mib)
                self.loads += 1
        dt = self._fault_s(m)
        await asyncio.sleep(dt / self.speedup)
        return dt

    async def evict(self, name: str) -> None:
        m = self.models[name]
        async with self._lock:
            if name in self._loaded:
                self._loaded.discard(name)
                self.resident_mib -= m.size_mib
                self.evicts += 1

    async def infer(self, name: str, prompt: str, max_tokens: int):
        m = self.models[name]
        if name not in self._loaded:
            raise RuntimeError(f"infer on non-resident model {name}")
        prefill = len(prompt.split()) * self.prefill_s_per_tok * (m.size_mib / self.ref_mib)
        await asyncio.sleep(max(prefill, 1e-4) / self.speedup)
        return f"[{name}] ok"


# --------------------------------------------------------------------------
# Real vLLM backend (GPU node) — imported lazily.
# --------------------------------------------------------------------------
class VLLMBackend:
    """One vLLM engine per model, kept warm (process + CUDA context alive) and
    slept/woken by the pager. Keeping the engine warm is what makes a fault-in a
    weight DMA, not a multi-second re-init (PipeSwitch Table 1)."""

    def __init__(self, model_paths: dict[str, str], **engine_kwargs):
        from vllm import LLM  # GPU-only dependency
        self._LLM = LLM
        self._paths = dict(model_paths)
        self._kwargs = dict(engine_kwargs)
        self._engines: dict[str, object] = {}
        self._sleeping: set[str] = set()

    def _engine(self, name: str):
        eng = self._engines.get(name)
        if eng is None:
            eng = self._LLM(model=self._paths[name],
                            enable_sleep_mode=True, **self._kwargs)
            self._engines[name] = eng
        return eng

    async def load(self, name: str) -> float:
        loop = asyncio.get_running_loop()

        def _do():
            eng = self._engine(name)
            t0 = time.perf_counter()
            if name in self._sleeping:
                eng.wake_up()                 # host-master -> VRAM
                self._sleeping.discard(name)
            return time.perf_counter() - t0

        return await loop.run_in_executor(None, _do)

    async def evict(self, name: str) -> None:
        loop = asyncio.get_running_loop()

        def _do():
            eng = self._engines.get(name)
            if eng is not None and name not in self._sleeping:
                eng.sleep(level=1)            # weights -> pinned host RAM, KV freed
                self._sleeping.add(name)

        await loop.run_in_executor(None, _do)

    async def infer(self, name: str, prompt: str, max_tokens: int):
        loop = asyncio.get_running_loop()

        def _do():
            from vllm import SamplingParams
            eng = self._engine(name)
            out = eng.generate([prompt], SamplingParams(max_tokens=max_tokens))
            return out[0].outputs[0].text

        return await loop.run_in_executor(None, _do)


def measure_wake(model_path: str, prompt="Hello,", rounds=3, **engine_kwargs):
    """Sleep/wake one engine `rounds` times and print wall-clock wake latency;
    use it to set the pinned_ram tier bandwidth in simulate.py / the pager.
    GPU-only; run manually on a node."""
    async def _run():
        be = VLLMBackend({"m": model_path}, **engine_kwargs)
        await be.load("m")
        await be.infer("m", prompt, 8)
        for i in range(rounds):
            await be.evict("m")
            dt = await be.load("m")
            await be.infer("m", prompt, 8)
            print(f"wake round {i}: {dt * 1000:.1f} ms")

    asyncio.run(_run())


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python3 backend.py <model_path_or_hf_id>   (GPU node)")
        raise SystemExit(2)
    measure_wake(sys.argv[1])
