"""SingGuard sidecar server — lifecycle, JSON-RPC loop, warmup, fail-closed.

Run as:  conda run -n Audio python -m guard.server [--model PATH] [--heads PATH]

Stdout carries ONLY JSON-RPC protocol lines. Diagnostics -> stderr so the
Bun host's stdout reader never sees non-protocol bytes (COGNITION §3).

Safety policy (COGNITION §B): hardcoded rules fire first and are unbypassable;
on model unavailability, every classify is fail-closed (block) because the
host only calls classify for sensitive operations. Adversarial approval
(§A) is a stub hook here (the host-side second-LLM review is orchestrated by
the Bun side; the sidecar exposes the static gate + hardcoded layer).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Do not pin HF_HOME / offline flags to a machine path. Set them in the
# environment if you need a custom cache or air-gapped load.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

_REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = os.environ.get("SG_MODEL_PATH") or str(_REPO_ROOT / "model")
DEFAULT_HEADS = os.environ.get("SG_HEADS_DIR") or str(Path(DEFAULT_MODEL) / "nsfa_heads")

import torch  # noqa: E402

from . import protocol as P  # noqa: E402
from . import rpc  # noqa: E402
from .heads import load_heads, score  # noqa: E402
from .hardcoded_rules import AuditRecord, evaluate as eval_hardcoded  # noqa: E402
from .model import GuardModel  # noqa: E402
from .prompts import prepare_prompt  # noqa: E402
from .quantization import resolve_device  # noqa: E402

# review band: a head within this margin above its threshold -> review, not
# block, so a human adjudicates the uncertain case (COGNITION §A.2 gray zone).
REVIEW_MARGIN = 0.15


class Sidecar:
    def __init__(self, model_path: str, heads_dir: str, use_4bit: bool = True):
        self.model_path = model_path
        self.heads_dir = heads_dir
        self.use_4bit = use_4bit
        self.device = resolve_device()
        self.heads = []
        self.model = None
        self.ready = False
        self.model_available = False
        self._load_error = None

    def load(self):
        """Load heads + model and warmup. Sets self.ready on success; on
        failure sets model_available=False (classify will fail-closed)."""
        try:
            sys.stderr.write("[sidecar] loading heads ...\n"); sys.stderr.flush()
            self.heads = load_heads(self.heads_dir, self.device)
            sys.stderr.write(f"[sidecar] {len(self.heads)} heads loaded\n")
            sys.stderr.flush()
            sys.stderr.write("[sidecar] loading model (4-bit) ...\n"); sys.stderr.flush()
            self.model = GuardModel(self.model_path, self.device,
                                    use_4bit=self.use_4bit)
            self.model.load()
            self.model_available = True
            sys.stderr.write(f"[sidecar] model class={type(self.model.model).__name__}\n")
            self._warmup()
            self.ready = True
            sys.stderr.write("[sidecar] READY\n"); sys.stderr.flush()
        except Exception as e:  # noqa: BLE001
            import traceback
            self._load_error = f"{type(e).__name__}: {e}"
            sys.stderr.write(f"[sidecar] LOAD FAILED (fail-closed): {self._load_error}\n")
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            self.model_available = False
            # Heads-only readiness: hardcoded rules can still fire; model path fail-closed.
            self.ready = True

    def _warmup(self):
        """Warm BOTH the forward pass AND head scoring in one pass (global
        resource principle: warm the full pipeline, not just the model)."""
        text = "This is a warmup probe. Verify system integrity."
        prompt = prepare_prompt(self.model.tokenizer, text, task="query")
        ids = self.model.tokenizer.encode(prompt, return_tensors="pt",
                                          add_special_tokens=False)
        emb = self.model.embed(ids)
        for h in self.heads:
            if h.task == "query":
                score(self.heads, emb, task="query")
        sys.stderr.write("[sidecar] warmup done (forward + heads)\n")
        sys.stderr.flush()

    # --- classify handler --------------------------------------------------
    def classify(self, params: dict) -> dict:
        task = params.get("task")
        text = params.get("text")
        if task not in ("query", "response"):
            raise rpc.JsonRpcError(P.ErrorCode.INVALID_PARAMS,
                                   "task must be 'query' or 'response'")
        if not isinstance(text, str):
            raise rpc.JsonRpcError(P.ErrorCode.INVALID_PARAMS,
                                   "text must be a string")
        if not self.ready:
            raise rpc.JsonRpcError(P.ErrorCode.NOT_READY, "sidecar not ready")
        thresholds = params.get("thresholds") or {}
        audit = params.get("audit") or {}
        tool = audit.get("tool", "Bash") if task == "query" else "Write"
        is_write = task == "response"

        # 1. Hardcoded layer FIRST (§B) — unbypassable.
        hc = eval_hardcoded(AuditRecord(
            tool=tool, operation=audit.get("operation", ""),
            cwd=audit.get("cwd", ""), input=text, is_write=is_write))
        if hc and hc.severity == "block":
            return P.GuardVerdict(
                verdict="block", task=task, risks=[], hardcoded=hc,
                analysis="hardcoded absolute-forbidden rule", model_available=self.model_available)

        # 2. Model unavailable -> sensitive op fail-closed (§B.1).
        if not self.model_available:
            err = self._load_error or "model not available"
            return P.GuardVerdict(
                verdict="block", task=task, risks=[],
                hardcoded=hc, analysis=f"fail-closed: {err}",
                model_available=False)

        # 3. Static gate — SingGuard heads.
        prompt = prepare_prompt(self.model.tokenizer, text, task=task,
                                system_prompt=None)
        ids = self.model.tokenizer.encode(prompt, return_tensors="pt",
                                          add_special_tokens=False)
        emb = self.model.embed(ids)
        risks = score(self.heads, emb, task=task, thresholds=thresholds)

        # 4. Combine verdict (monotone toward stricter, §B.3):
        #    any head > threshold -> block; any head in review band -> review;
        #    hardcoded review -> at least review; else allow.
        block_hit = next((r for r in risks if r.probability > r.threshold
                          and (r.probability - r.threshold) >= REVIEW_MARGIN), None)
        review_hit = next((r for r in risks if r.threshold < r.probability <= r.threshold + REVIEW_MARGIN), None)
        if block_hit:
            verdict = "block"
        elif hc and hc.severity == "review":
            verdict = "review"
        elif review_hit:
            verdict = "review"
        else:
            verdict = "allow"
        return P.GuardVerdict(
            verdict=verdict, task=task, risks=risks, hardcoded=hc,
            model_available=True)


def _verdict_to_dict(v: P.GuardVerdict) -> dict:
    return {
        "verdict": v.verdict,
        "task": v.task,
        "risks": [{"domain": r.domain, "probability": r.probability,
                   "threshold": r.threshold} for r in v.risks],
        "hardcoded": ({"rule_id": v.hardcoded.rule_id,
                       "severity": v.hardcoded.severity,
                       "reason": v.hardcoded.reason,
                       "matched": v.hardcoded.matched} if v.hardcoded else None),
        "analysis": v.analysis,
        "model_available": v.model_available,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--heads", default=DEFAULT_HEADS)
    ap.add_argument("--no-4bit", action="store_true")
    args = ap.parse_args()

    sidecar = Sidecar(args.model, args.heads, use_4bit=not args.no_4bit)
    sidecar.load()

    def handle_classify(params):
        return _verdict_to_dict(sidecar.classify(params))

    def handle_ping(params):
        return {"ready": sidecar.ready,
                "model_available": sidecar.model_available,
                "heads": [(h.domain, h.task) for h in sidecar.heads]}

    handlers = {
        P.METHOD_CLASSIFY: handle_classify,
        P.METHOD_PING: handle_ping,
    }
    # Emit a ready notification so the host can unblock.
    rpc.write_message(sys.stdout, {
        "jsonrpc": "2.0", "method": "ready",
        "params": {"ready": sidecar.ready,
                   "model_available": sidecar.model_available}})
    rpc.serve(handlers, sys.stdin, sys.stdout, sys.stderr,
              on_shutdown=lambda: sys.stderr.write("[sidecar] shutdown\n"))


if __name__ == "__main__":
    main()
