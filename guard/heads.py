"""NSFA classifier heads — loads the 7 .pth files and scores embeddings.

Head module structure is reconstructed from the actual state_dict keys
(probed from the downloaded .pth files, 2026-08-20):
    layers.0.0.*   = nn.Linear(input_size, 64)      shape (64, 1024)
    layers.0.1.*   = nn.LayerNorm(64)
    output_layer.* = nn.Linear(64, 2)               shape (2, 64)
  forward:  e -> Linear -> LayerNorm -> ReLU -> Dropout -> Linear -> logits(2)
This matches the card's EmbeddingHead: h = Dropout(ReLU(LayerNorm(W1 e + b1))).

CRITICAL (COGNITION §1.2 / §7 risk #3): the real `sub_task_name` values use
Title_Case_With_Underscores, NOT the lowercase snake_case the taxonomy JSON
uses. We key heads by data["sub_task_name"] read from each .pth at load time
and NEVER hardcode domain labels. Confirmed values:
  query    : Prompt_Injection_and_Jailbreak, Malicious_Code_and_Cyberattack,
             Sensitive_Information_Stealing, Dangerous_Operations_Tool_Abuse,
             Resource_Abuse
  response : Hazardous_Action_Generation, Sensitive_Information_Leakage
"""
from __future__ import annotations

import glob
import os
from dataclasses import dataclass
from typing import Dict, List, Optional

import torch
import torch.nn as nn

from . import protocol as P


class EmbeddingHead(nn.Module):
    """A single NSFA risk head. Module layout matches the .pth state_dict so
    load_state_dict succeeds with no key remapping."""

    def __init__(self, input_size: int = 1024, hidden_dims=(64,),
                 num_classes: int = 2, dropout_rate: float = 0.3,
                 use_layer_norm: bool = True, activation: str = "relu"):
        super().__init__()
        block = [nn.Linear(input_size, hidden_dims[0])]
        if use_layer_norm:
            block.append(nn.LayerNorm(hidden_dims[0]))
        # ModuleList so state_dict key is `layers.0.0` / `layers.0.1`.
        self.layers = nn.ModuleList([nn.Sequential(*block)])
        self.dropout = nn.Dropout(dropout_rate)
        self.output_layer = nn.Linear(hidden_dims[0], num_classes)
        self._act = nn.ReLU() if activation == "relu" else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for block in self.layers:
            x = block(x)
            x = self._act(x)
            x = self.dropout(x)
        return self.output_layer(x)


@dataclass
class LoadedHead:
    domain: str          # sub_task_name (Title_Case)
    task: str            # 'query' | 'response'
    module: EmbeddingHead
    max_tokens: int
    system_prompt: Optional[str]


def _build_head(head_config: dict) -> EmbeddingHead:
    hc = head_config or {}
    return EmbeddingHead(
        input_size=hc.get("input_size", 1024),
        hidden_dims=tuple(hc.get("hidden_dims", [64])),
        num_classes=hc.get("num_classes", 2),
        dropout_rate=hc.get("dropout_rate", 0.3),
        use_layer_norm=hc.get("use_layer_norm", True),
        activation=hc.get("activation", "relu"),
    )


def load_heads(heads_dir: str, device: torch.device) -> List[LoadedHead]:
    """Load every .pth in `heads_dir`. .pth are legacy pickles
    (weights_only=False) — only load from the trusted downloaded repo
    (COGNITION §7 risk #4)."""
    out: List[LoadedHead] = []
    for pth in sorted(glob.glob(os.path.join(heads_dir, "*.pth"))):
        data = torch.load(pth, weights_only=False, map_location="cpu")
        if not isinstance(data, dict):
            continue
        domain = data.get("sub_task_name")
        task = data.get("task")
        if not domain or task not in ("query", "response"):
            continue
        head = _build_head(data.get("head_config", {}))
        sd = data.get("head_state_dict") or {}
        head.load_state_dict(sd, strict=True)
        head.to(device).eval()
        for p in head.parameters():
            p.requires_grad_(False)
        out.append(LoadedHead(
            domain=domain, task=task, module=head,
            max_tokens=data.get("max_tokens", P.DEFAULT_MAX_TOKENS),
            system_prompt=data.get("system_prompt"),
        ))
    return out


@torch.no_grad()
def score(heads: List[LoadedHead], embedding: torch.Tensor, task: str,
          thresholds: Optional[Dict[str, float]] = None) -> List[P.Risk]:
    """Run every head matching `task` against `embedding` (shape (1, 1024) or
    (1024,)). Returns one Risk per matching head. probability = softmax(logits)[1].
    """
    thresholds = thresholds or {}
    if embedding.dim() == 1:
        embedding = embedding.unsqueeze(0)
    embedding = embedding.to(torch.float32)
    risks: List[P.Risk] = []
    for h in heads:
        if h.task != task:
            continue
        # Align device: embedding may be CPU (embed() returns CPU); heads ride
        # the model device (cuda:0). Matmul needs both on the same device.
        dev = next(h.module.parameters()).device
        emb = embedding.to(dev)
        logits = h.module(emb)                 # (1, 2)
        probs = torch.softmax(logits, dim=-1)    # (1, 2)
        prob = float(probs[0, 1].item())         # P(unsafe)
        thr = thresholds.get(h.domain, P.DEFAULT_THRESHOLD)
        risks.append(P.Risk(domain=h.domain, probability=prob, threshold=thr))
    return risks
