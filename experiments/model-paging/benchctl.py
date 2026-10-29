"""Drive `vllm bench serve` across all models against the paging proxy.

Standard vllm-bench targets one model; this launches one `vllm bench serve` per
model concurrently, with per-model request rates from a Zipfian popularity (a
few hot models get most traffic), so the proxy sees a realistic multi-model
serverless load and actually pages. GPU node; needs vllm installed. Anything
after `--` is passed through to every `vllm bench serve`.

Example:
    python3 benchctl.py --config models.json --base-url http://127.0.0.1:8000 \
        --total-rate 20 --num-prompts 1500 -- --random-input-len 512
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


def zipf_weights(n, s):
    return [1.0 / ((r + 1) ** s) for r in range(n)]


def main():
    p = argparse.ArgumentParser(description="Multi-model vllm-bench orchestrator")
    p.add_argument("--config", required=True, help="same models config as serve.py")
    p.add_argument("--base-url", default="http://127.0.0.1:8000")
    p.add_argument("--total-rate", type=float, default=10.0, help="aggregate req/s")
    p.add_argument("--num-prompts", type=int, default=2000, help="per model")
    p.add_argument("--skew", type=float, default=1.1, help="Zipf popularity skew")
    p.add_argument("--backend", default="openai-chat")
    p.add_argument("--endpoint", default="/v1/chat/completions")
    p.add_argument("--burstiness", type=float, default=0.5,
                   help="vllm-bench arrival burstiness (<1 = burstier)")
    p.add_argument("extra", nargs=argparse.REMAINDER,
                   help="args after -- passed to every vllm bench serve")
    args = p.parse_args()

    names = [e["name"] for e in json.load(open(args.config))]
    w = zipf_weights(len(names), args.skew)
    total = sum(w)
    passthrough = args.extra[1:] if args.extra[:1] == ["--"] else args.extra

    procs = []
    for name, wi in zip(names, w):
        rate = max(0.01, args.total_rate * wi / total)
        cmd = ["vllm", "bench", "serve",
               "--backend", args.backend, "--endpoint", args.endpoint,
               "--base-url", args.base_url, "--model", name,
               "--request-rate", f"{rate:.4f}", "--burstiness", str(args.burstiness),
               "--num-prompts", str(args.num_prompts),
               "--dataset-name", "random",
               "--save-result", "--result-filename", f"bench-{name}.json"] + passthrough
        print("launch:", " ".join(cmd))
        procs.append(subprocess.Popen(cmd))

    rc = 0
    for pr in procs:
        rc |= pr.wait()
    print("all vllm-bench runs finished; see bench-*.json")
    sys.exit(rc)


if __name__ == "__main__":
    main()
