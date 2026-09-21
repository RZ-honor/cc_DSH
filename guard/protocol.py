"""Protocol types & constants for the SingGuard sidecar.

Pure-stdlib: dataclasses + enums. No torch/transformers import so this module
is importable (and unit-testable) without the ML stack.

Shapes mirror COGNITION.md §3 (JSON-RPC over stdio) and §B (hardcoded rules).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Optional

# --- task sides -------------------------------------------------------------
Task = Literal["query", "response"]

# Canonical domain labels (head `sub_task_name` values). The response-side
# labels are *expected*; heads.py reads the real `sub_task_name` from each .pth
# at load time and these constants are only the documented defaults.
QUERY_DOMAINS = (
    "prompt_injection_and_jailbreak",
    "malicious_code_and_cyberattack",
    "sensitive_info_stealing",
    "danger_ops_and_tool_abuse",
    "resource_abuse",
)
RESPONSE_DOMAINS = (
    "hazardous_action_generation",
    "sensitive_info_leakage",
)
ALL_DOMAINS = QUERY_DOMAINS + RESPONSE_DOMAINS

DOMAINS_BY_TASK = {
    "query": QUERY_DOMAINS,
    "response": RESPONSE_DOMAINS,
}

DEFAULT_THRESHOLD = 0.5
DEFAULT_MAX_TOKENS = 8192

# --- prepare_prompt constants (ported from the model card) ------------------
TOKEN_SAFETY_MARGIN = 200
CHARS_PER_TOKEN_SAFETY_RATIO = 0.2
TEMPLATE_CALIBRATION_TEXT = "This is a test string"

# --- verdict ----------------------------------------------------------------
Verdict = Literal["allow", "block", "review"]


@dataclass
class Risk:
    """One head's evaluation result."""
    domain: str
    probability: float
    threshold: float


@dataclass
class HardcodedHit:
    """A §B hardcoded-rule match. `severity` is 'block' (absolute forbidden)
    or 'review' (high-risk, force manual approval). Unbypassable by model."""
    rule_id: str
    severity: Literal["block", "review"]
    reason: str
    matched: Optional[str] = None


@dataclass
class GuardVerdict:
    """Final sidecar verdict returned to the Bun host."""
    verdict: Verdict
    task: Task
    risks: list = field(default_factory=list)  # list[Risk]
    hardcoded: Optional[HardcodedHit] = None
    analysis: Optional[str] = None
    model_available: bool = True


# --- JSON-RPC ---------------------------------------------------------------
class ErrorCode(str, Enum):
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"     # sidecar model failed to init/load
    NOT_READY = "NOT_READY"                      # still warming up
    TIMEOUT = "TIMEOUT"                          # classify exceeded deadline
    INVALID_PARAMS = "INVALID_PARAMS"            # bad task / text / thresholds
    METHOD_NOT_FOUND = "METHOD_NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# Methods the sidecar exposes over stdio.
METHOD_CLASSIFY = "classify"
METHOD_PING = "ping"
METHOD_SHUTDOWN = "shutdown"
