"""Workload generation for the model-paging POC.

A set of models across tenants with a skewed (Zipfian) popularity, and a request
trace with tunable arrival burstiness (Poisson or Gamma with a target CV). This
is the "N tenants, bursty arrival, Σmodels > VRAM" setting from the prototype
plan in MODEL-PAGING.md.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from residency import Model


@dataclass(frozen=True)
class Request:
    arrival: float          # seconds
    model: Model
    prompt_tokens: int
    output_tokens: int


def make_models(n_models, n_tenants, size_choices_mib, master_tier, rng,
                nvme_frac=0.0, slow_tier="nvme"):
    """n_models spread round-robin across n_tenants; size drawn from
    size_choices_mib. Masters sit in `master_tier`, except a `nvme_frac` fraction
    placed on `slow_tier` — so cost-aware eviction has a reason to prefer keeping
    the slow-to-reload ones resident (multi-tier study)."""
    models = []
    for i in range(n_models):
        tier = slow_tier if rng.random() < nvme_frac else master_tier
        models.append(Model(
            name=f"m{i:03d}",
            tenant=f"t{i % n_tenants}",
            size_mib=rng.choice(size_choices_mib),
            master_tier=tier,
        ))
    return models


def _zipf_weights(n, s):
    # unnormalised 1/rank^s; random.choices normalises for us.
    return [1.0 / ((r + 1) ** s) for r in range(n)]


def gen_trace(models, n_requests, rate_rps, cv, popularity_s,
              prompt_mean, output_mean, rng):
    """Generate `n_requests` requests.

    - popularity: Zipf over models with skew `popularity_s` (0 = uniform,
      higher = more skewed; a few hot models get most traffic).
    - arrivals: a renewal process with mean inter-arrival 1/rate_rps and
      coefficient of variation `cv`. cv=1 is Poisson; cv>1 is bursty (Gamma).
    - tokens: geometric-ish around the given means (>=1).
    """
    weights = _zipf_weights(len(models), popularity_s)
    mean_gap = 1.0 / rate_rps
    # Gamma(shape=k, scale=theta): mean=k*theta, cv=1/sqrt(k).
    k = 1.0 / (cv * cv)
    theta = mean_gap / k

    t = 0.0
    out = []
    for _ in range(n_requests):
        t += rng.gammavariate(k, theta) if cv != 1.0 else rng.expovariate(rate_rps)
        m = rng.choices(models, weights=weights, k=1)[0]
        out.append(Request(
            arrival=t,
            model=m,
            prompt_tokens=max(1, int(rng.expovariate(1.0 / prompt_mean))),
            output_tokens=max(1, int(rng.expovariate(1.0 / output_mean))),
        ))
    return out


def total_weight_mib(models):
    return sum(m.size_mib for m in models)
