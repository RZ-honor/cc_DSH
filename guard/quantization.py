"""Quantization & device strategy for SingGuard-NSFA-0.8B on a 2GB MX450.

The bf16 weights are ~2.06 GiB > 2 GiB VRAM (COGNITION §6), so we load in
4-bit NF4 (~600-700 MB weight memory) with double-quantization and bfloat16
compute dtype, plus accelerate device_map='auto' so any layer that still
overflows VRAM spills to CPU (slow but correct). Heads are tiny (~268 KB
each) and ride the embedding's device.

This is a SIDECAR-CHOICE (COGNITION §1.2 — the research documents no official
4-bit/CPU-offload recipe; vLLM's gpu_memory_utilization is not applicable to
the transformers route). Validate the resulting embedding against the
compound-attack fixture (COGNITION §7 risk #1) — quantization must not
perturb the last-token hidden state enough to flip head verdicts.
"""
from __future__ import annotations

import torch


def build_4bit_config():
    """BitsAndBytes 4-bit NF4 config. Requires bitsandbytes + accelerate."""
    from transformers import BitsAndBytesConfig
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )


def resolve_device() -> torch.device:
    """Prefer CUDA (MX450) when it can host the 4-bit model; else CPU.
    The final decision still goes through device_map='auto' for offload."""
    if torch.cuda.is_available():
        return torch.device("cuda:0")
    return torch.device("cpu")
