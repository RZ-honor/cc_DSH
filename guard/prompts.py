"""Prompt preparation for SingGuard inference — faithful port of the model
card's `prepare_prompt` / `_escape_xml` / `_wrap_text_escaped` /
`_truncate_escaped_text` / `_compute_template_overhead`.

These functions replicate the official vLLM embedding-mode input contract:
  coerce -> measure template overhead -> XML-escape -> left-truncate (keep the
  LAST token_budget tokens) -> wrap in <untrusted_input>/<untrusted_output>
  boundary tags -> apply chat template with add_generation_prompt=True.

The last token of the scaffolded prompt is the embedding position the heads
were trained on. DO NOT drop add_generation_prompt=True or you shift that
position and the embedding becomes meaningless (COGNITION §1.2 / §7 risk #1).

A tokenizer handle is injected (duck-typed: needs .encode / .decode /
.apply_chat_template). This keeps the module importable without torch so the
escape/wrap logic is unit-testable with a stub tokenizer.
"""
from __future__ import annotations

from typing import Optional

from . import protocol as P

_UNTRUSTD_TAGS = {"query": "untrusted_input", "response": "untrusted_output"}


def coerce_to_string(text) -> str:
    """Mirror the card's coercion: None -> '', else str(text)."""
    if text is None:
        return ""
    return text if isinstance(text, str) else str(text)


def escape_xml(text: str) -> str:
    """Card's `_escape_xml`: & < > only (order matters)."""
    return (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))


def wrap_inference_input(escaped_text: str, task: str) -> str:
    """Card's `_wrap_text_escaped`. NOTE the literal newlines inside the tags."""
    tag = _UNTRUSTD_TAGS[task]
    return f"<{tag}>\n{escaped_text}\n</{tag}>"


def compute_template_overhead(tokenizer, task: str, system_prompt: Optional[str],
                               max_tokens: int = P.DEFAULT_MAX_TOKENS) -> int:
    """Card's `_compute_template_overhead`: tokens added by the scaffold
    (wrap + chat template + add_generation_prompt) for the calibration text."""
    bare = P.TEMPLATE_CALIBRATION_TEXT
    wrapped = wrap_inference_input(escape_xml(bare), task)
    msgs = []
    if system_prompt:
        msgs.append({"role": "system", "content": system_prompt})
    msgs.append({"role": "user", "content": wrapped})
    scaffolded = tokenizer.apply_chat_template(
        msgs, tokenize=True, add_generation_prompt=True)
    if isinstance(scaffolded, (list, tuple)):
        n_full = len(scaffolded)
    else:  # some tokenizers return a tensor-like; coerce
        n_full = len(scaffolded)
    n_bare = len(tokenizer.encode(bare, add_special_tokens=False))
    return max(0, n_full - n_bare)


def truncate_escaped_text(tokenizer, escaped_text: str, token_budget: int) -> str:
    """Card's `_truncate_escaped_text`: left-truncate, keeping the LAST
    token_budget tokens (matches tokenizer truncation_side='left')."""
    char_threshold = int(token_budget * P.CHARS_PER_TOKEN_SAFETY_RATIO)
    if len(escaped_text) <= char_threshold:
        return escaped_text
    token_ids = tokenizer.encode(escaped_text, add_special_tokens=False)
    if len(token_ids) <= token_budget:
        return escaped_text
    kept = token_ids[-token_budget:]
    return tokenizer.decode(kept)


def prepare_prompt(tokenizer, text, task: str, system_prompt: Optional[str] = None,
                    max_tokens: int = P.DEFAULT_MAX_TOKENS) -> str:
    """Card's `prepare_prompt`: full pipeline -> scaffolded prompt string."""
    if task not in _UNTRUSTD_TAGS:
        raise ValueError(f"task must be 'query' or 'response', got {task!r}")
    escaped = escape_xml(coerce_to_string(text))
    overhead = compute_template_overhead(tokenizer, task, system_prompt, max_tokens)
    token_budget = max_tokens - overhead - P.TOKEN_SAFETY_MARGIN
    if token_budget < 1:
        # Pathological: scaffold alone exceeds max_tokens. Keep a minimal tail
        # rather than producing an empty prompt; the heads still score something.
        token_budget = 1
    escaped = truncate_escaped_text(tokenizer, escaped, token_budget)
    wrapped = wrap_inference_input(escaped, task)
    msgs = []
    if system_prompt:
        msgs.append({"role": "system", "content": system_prompt})
    msgs.append({"role": "user", "content": wrapped})
    return tokenizer.apply_chat_template(
        msgs, tokenize=False, add_generation_prompt=True)
