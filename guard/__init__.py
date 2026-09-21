"""SingGuard guard sidecar — NSFA-0.8B operation-risk guardrail.

This package implements the Python sidecar described in COGNITION.md §3.
It is spawned by the Bun host (`conda run -n Audio python -m guard.server`)
and speaks newline-delimited JSON-RPC over stdio.

Modules (dependency order):
  protocol        — verdict/protocol types & constants (no deps)
  rpc             — JSON-RPC 2.0 framing over stdio (depends on protocol)
  prompts         — XML-escape / wrap / left-truncate / chat-template (from model card)
  hardcoded_rules — §B hardcoded fail-closed rules (independent of model)
  quantization    — 4-bit BitsAndBytes + device-map CPU offload
  model           — model/tokenizer load + last-token hidden-state extraction
  heads           — load 7 .pth heads + softmax scoring (keyed by sub_task_name)
  server          — lifecycle / ready / JSON-RPC loop / warmup / request errors

Safety invariants (COGNITION §B): hardcoded rules fire first and cannot be
bypassed by the model; on any model/sidecar unavailability, sensitive
operations are fail-closed. See hardcoded_rules.py.
"""
__version__ = "0.1.0"
