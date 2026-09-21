"""Model load + last-token hidden-state extraction (the vLLM embedding contract).

We replicate vLLM's `PoolerConfig(pooling_type="LAST", normalize=False)`:
the embedding is the final-layer hidden state at the last input position,
cast to float32, shape (1, 1024). The heads consume it directly
(COGNITION §1.2).

Two routes exist for the multimodal Qwen3_5ForConditionalGeneration in
text-only mode (COGNITION §7 risk #2):
  (A) top-level forward with input_ids only + output_hidden_states=True;
  (B) fall back to the text trunk (model.language_model / model.model) if the
      vision tower complains. Empirically resolved by verify_embedding.py.

The input_ids fed here MUST come from prepare_prompt() (prompts.py) which
applies the chat template with add_generation_prompt=True — the last token
is the assistant-turn prefix token the heads were trained on.
"""
from __future__ import annotations

import os
from typing import Optional

import torch

from . import quantization as Q


class GuardModel:
    """Holds the tokenizer + backbone and produces last-token embeddings."""

    def __init__(self, model_path: str, device: torch.device,
                 use_4bit: bool = True, trust_remote_code: bool = True):
        self.model_path = model_path
        self.device = device
        self.tokenizer = None
        self.model = None
        self._text_trunk = None        # cached text-only forward target
        self._loaded = False
        self._trust_remote_code = trust_remote_code
        self._use_4bit = use_4bit

    def load(self) -> None:
        from transformers import AutoTokenizer, AutoModelForCausalLM
        tok = AutoTokenizer.from_pretrained(
            self.model_path, trust_remote_code=self._trust_remote_code,
            truncation_side="left", use_fast=True)
        # Pad token fallback (Qwen tokenizers sometimes lack pad_token).
        if tok.pad_token is None:
            tok.pad_token = tok.eos_token
        self.tokenizer = tok

        kwargs = dict(trust_remote_code=self._trust_remote_code)
        if self._use_4bit:
            kwargs["quantization_config"] = Q.build_4bit_config()
        else:
            kwargs["torch_dtype"] = torch.bfloat16
        kwargs["device_map"] = "auto" if self._use_4bit else None

        # Qwen3_5ForConditionalGeneration is the multimodal class in config.json,
        # but for text-only embedding we want the causal-LM forward. AutoModelForCausalLM
        # resolves to the right text class for qwen3_5; fall back to the explicit
        # multimodal class only if AutoModelForCausalLM refuses the config.
        try:
            self.model = AutoModelForCausalLM.from_pretrained(
                self.model_path, **kwargs)
        except Exception:
            from transformers import AutoModel
            self.model = AutoModel.from_pretrained(self.model_path, **kwargs)

        if not self._use_4bit:
            self.model = self.model.to(self.device)
        self.model.eval()
        for p in self.model.parameters():
            p.requires_grad_(False)
        self._loaded = True

    # --- text-only forward target ------------------------------------------
    def _trunk(self):
        """Return the module whose forward(input_ids=..., output_hidden_states=True)
        yields last_hidden_state. Prefer the text trunk for multimodal models."""
        if self._text_trunk is not None:
            return self._text_trunk
        for attr in ("language_model", "model"):
            obj = getattr(self.model, attr, None)
            if obj is not None and callable(getattr(obj, "forward", None)):
                self._text_trunk = obj
                return obj
        self._text_trunk = self.model
        return self._text_trunk

    @torch.no_grad()
    def embed(self, input_ids: torch.Tensor) -> torch.Tensor:
        """Return last-token hidden state, float32, shape (1, hidden_size).

        input_ids: (1, L) on the appropriate device.
        """
        ids = input_ids.to(self.device)
        trunk = self._trunk()
        try:
            out = trunk(input_ids=ids, output_hidden_states=True,
                        return_dict=True)
        except TypeError:
            # trunk.forward may not accept output_hidden_states; use the top model.
            out = self.model(input_ids=ids, output_hidden_states=True,
                             return_dict=True)
        hs = out.hidden_states   # tuple of (1, L, H), last entry = final layer
        last_layer = hs[-1] if hs is not None else out.last_hidden_state
        emb = last_layer[:, -1, :].to(torch.float32).cpu()
        return emb  # (1, 1024)
