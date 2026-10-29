"""Real vLLM backend — the seam between the policy and a GPU.

Run on a GPU node (needs `pip install vllm` and a CUDA/ROCm device). The
simulator never imports this; it exists to (a) show how the ResidencyManager's
evict/fault-in decisions map onto a real engine, and (b) measure *wall-clock*
wake latency so the simulator's per-tier bandwidths can be calibrated — step 1
of the prototype plan in MODEL-PAGING.md.

The mechanism is vLLM sleep/wake: `sleep(level=1)` offloads weights to pinned
host RAM and frees the KV cache (clean-cache evict); `wake_up()` re-DMAs them
(fault-in). KV is dropped on sleep and rebuilt by recompute on the next request.

This file is intentionally not exercised by the test suite or the simulator.
"""

from __future__ import annotations

import time
from typing import Protocol


class Backend(Protocol):
    def load(self, name: str) -> float: ...   # wake; returns wall-clock seconds
    def evict(self, name: str) -> None: ...    # sleep
    def infer(self, name: str, prompt: str, max_tokens: int): ...


class VLLMBackend:
    """One vLLM engine per model, kept warm (process + CUDA context alive) and
    slept/woken by the residency manager. Keeping the engine warm is what makes
    fault-in a weight DMA rather than a multi-second re-init (PipeSwitch Table 1).
    """

    def __init__(self, model_paths: dict[str, str], **engine_kwargs):
        from vllm import LLM  # imported lazily: GPU-only dependency
        self._LLM = LLM
        self._paths = dict(model_paths)
        self._kwargs = dict(engine_kwargs)
        self._engines: dict[str, object] = {}
        self._sleeping: set[str] = set()

    def _engine(self, name: str):
        eng = self._engines.get(name)
        if eng is None:
            # enable_sleep_mode keeps the weights' host master for fast wake.
            eng = self._LLM(model=self._paths[name],
                            enable_sleep_mode=True, **self._kwargs)
            self._engines[name] = eng
        return eng

    def load(self, name: str) -> float:
        eng = self._engine(name)
        t0 = time.perf_counter()
        if name in self._sleeping:
            eng.wake_up()            # host-master -> VRAM
            self._sleeping.discard(name)
        return time.perf_counter() - t0

    def evict(self, name: str) -> None:
        eng = self._engines.get(name)
        if eng is not None and name not in self._sleeping:
            eng.sleep(level=1)       # weights -> pinned host RAM, KV freed
            self._sleeping.add(name)

    def infer(self, name: str, prompt: str, max_tokens: int):
        from vllm import SamplingParams
        eng = self._engine(name)
        return eng.generate([prompt], SamplingParams(max_tokens=max_tokens))


def measure_wake(model_path: str, prompt="Hello,", rounds=3, **engine_kwargs):
    """Sleep/wake a single engine `rounds` times and print wall-clock wake
    latency. Use the number to set the pinned_ram tier bandwidth in simulate.py.
    GPU-only; run manually on a node."""
    be = VLLMBackend({"m": model_path}, **engine_kwargs)
    be.load("m")
    be.infer("m", prompt, 8)          # warm
    for i in range(rounds):
        be.evict("m")
        dt = be.load("m")
        be.infer("m", prompt, 8)
        print(f"wake round {i}: {dt * 1000:.1f} ms")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python3 vllm_backend.py <model_path_or_hf_id>  (GPU node)")
        raise SystemExit(2)
    measure_wake(sys.argv[1])
