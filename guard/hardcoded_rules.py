"""§B Hardcoded safety-fallback rules — the most core, non-bypassable layer.

These fire BEFORE and INDEPENDENTLY of the SingGuard model. A block here is
final; the model cannot override it. A review here forces manual approval
regardless of model verdict. On any model/sidecar unavailability, sensitive
operations stay fail-closed (handled in server.py, see COGNITION §B.1).

Priority chain (COGNITION §B.3): hardcoded rules > adversarial approval >
SingGuard static gate > DSH sandbox > settings.json > hooks > tool perms.
Low layers may not overturn a high-layer deny.

The rules operate on a normalized AuditRecord (tool/operation/cwd/input).
For Bash, `input` is the command string. For Write/Edit, `input` is the
exact file content or patch being written. Both are scanned so a benign
command description can't smuggle a dangerous patch (response-side risk).

This is a first cut. Extend ABSOLUTE_FORBIDDEN / HIGH_RISK as the test
matrix (COGNITION §8) grows. Patterns are regex, case-insensitive.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from . import protocol as P


@dataclass
class AuditRecord:
    tool: str            # 'Bash' | 'Write' | 'Edit' | 'Glob' | 'Read' | ...
    operation: str       # free-form: 'run_command' | 'write_file' | ...
    cwd: str             # session cwd (for out-of-workspace detection)
    input: str           # the command OR file content/patch being audited
    is_write: bool = False


# --- Absolute-forbidden patterns -> block (unbypassable) -------------------
# Each: (rule_id, compiled regex, reason). Matched against `input`.
_ABSOLUTE = [
    ("HC-FORBID-RMRF-ROOT",
     re.compile(r"\brm\b(?=[^|;\n]*\s-[a-z]*r)(?=[^|;\n]*\s-[a-z]*f)"
                r"[^|;\n]*\s+(?:/(?:[\s*]|$)|~/?\s*(?:;|\||&|$))", re.I),
     "recursive delete of root / home — absolute forbidden"),
    ("HC-FORBID-RMRF-WILDCARD",
     re.compile(r"\brm\b(?=[^|;\n]*\s-[a-z]*r)(?=[^|;\n]*\s-[a-z]*f)"
                r"[^|;\n]*\s+(?:/\*|~/.+\*|\*\s*$)", re.I),
     "recursive wildcard mass delete"),
    ("HC-FORBID-MKFS",
     re.compile(r"\bmkfs(?:\.\w+)?\b"), re.I),
    ("HC-FORBID-DD-BLKDEV",
     re.compile(r"\bdd\b[^|;\n]*\bof\s*=\s*/dev/(?:sd|nvme|hd|disk)"), re.I),
    ("HC-FORBID-CHMOD-SYSROOT",
     re.compile(r"\bchmod\b[^|;\n]*-R[^|;\n]*\s+/(?:\s|$)|\bchmod\b[^|;\n]*\s+[0-7]{3,4}\s+/(?:etc|bin|usr|sbin|boot|root)(?:\s|$)"), re.I),
    ("HC-FORBID-FORKBOMB",
     re.compile(r":\(\)\s*\{[^}]*:[|][^}]*\}\s*;?\s*:\s*\)\s*[|&]"), re.I),
    ("HC-FORBID-DEV-TCP-SHELL",
     re.compile(r"\b(?:bash|sh|zsh)\b[^|;\n]*-i[^|;\n]*(?:/dev/(?:tcp|udp)/|<\s*/dev/(?:tcp|udp)/)"), re.I),
    ("HC-FORBID-NC-E-SHELL",
     re.compile(r"\bnc\b[^|;\n]*\s-e\b[^|;\n]*(?:/bin/(?:bash|sh)|sh\s|bash\b)"), re.I),
    ("HC-FORBID-CURL-PIPE-SHELL",
     re.compile(r"\b(?:curl|wget)\b[^|;\n]*\|\s*(?:bash|sh|zsh|python)\b"), re.I),
    ("HC-FORBID-REVSHELL-PY",
     re.compile(r"python[^|;\n]*-c[^|;\n]*(?:socket\.|subprocess\.|os\.system.*sh)"), re.I),
    ("HC-FORBID-WRITE-BLKDEV",
     re.compile(r">\s*/dev/(?:sd|nvme|hd|disk|sda|sdb|nvme0n)"), re.I),
    ("HC-FORBID-PRIVATE-KEY-LEAK",
     re.compile(r"-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----"), re.I),
]

# --- High-risk patterns -> review (force manual Y/N; never auto-allow) ------
_HIGH_RISK = [
    ("HC-HR-PRIV-ESCALATION",
     re.compile(r"\b(?:sudo|su\b|runas|doas)\b"), re.I),
    ("HC-HR-CHMOD-SUID",
     re.compile(r"\bchmod\b[^|;\n]*[0-7]{4}\b|u\+s|g\+s"), re.I),
    ("HC-HR-GIT-FORCE",
     re.compile(r"\bgit\b[^|;\n]*(?:push\s+--force|push\s+-f|reset\s+--hard|clean\s+-fdx?)"), re.I),
    ("HC-HR-PKG-INSTALL",
     re.compile(r"\b(?:pip|pip3|conda|npm|yarn|cargo|gem)\b[^|;\n]*(?:install|i|add)\b"), re.I),
    ("HC-HR-DB-DESTRUCTIVE",
     re.compile(r"\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE|DELETE\s+FROM\b)", re.I),
     "DELETE without WHERE handled separately below"),
    ("HC-HR-DELETE-NO-WHERE",
     re.compile(r"DELETE\s+FROM\s+\w+(?:\s|;|$)(?!.*\bWHERE\b)", re.I | re.DOTALL)),
    ("HC-HR-NET-EGRESS",
     re.compile(r"\b(?:curl|wget|scp|rsync|nc|netcat|ncat)\b[^|;\n]*(?:https?://|@(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[a-z0-9.-]+\.[a-z]{2,})"), re.I),
    ("HC-HR-CRED-EXFIL",
     re.compile(r"\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_\-]{35}|sk-[A-Za-z0-9]{20,})"), re.I),
    ("HC-HR-WRITE-SYS-PATH",
     re.compile(r"(?:^|[\s\"'`])(?:/(?:etc|bin|usr|sbin|boot|root|proc|sys)|C:\\(?:Windows|Program Files|Users\\[^\\]+\\AppData\\Roaming))(?:[\s\"'`/\\]|$)"), re.I),
    ("HC-HR-CHOWN-SYS",
     re.compile(r"\bchown\b[^|;\n]*-R"), re.I),
    ("HC-HR-SYSTEMCTL-DISABLE",
     re.compile(r"\b(?:systemctl|service)\b[^|;\n]*(?:disable|mask|stop|kill)"), re.I),
    ("HC-HR-CRON-PERSIST",
     re.compile(r"\bcrontab\b|(?:/etc/cron(?:\.\w+)?/)"), re.I),
    ("HC-HR-RM-RECURSIVE",
     re.compile(r"\brm\b[^|;\n]*-r", re.I),
     "recursive delete — review even outside root"),
]


def _scan(patterns, text):
    for rule_id, rx, *reason in patterns:
        m = rx.search(text)
        if m:
            r = reason[0] if reason else rule_id
            return rule_id, m.group(0), r
    return None


def evaluate(record: AuditRecord) -> Optional[P.HardcodedHit]:
    """Apply hardcoded rules. Returns a HardcodedHit (block or review) or None
    (pass — no hardcoded rule matched; fall through to model)."""
    text = record.input or ""
    if not text:
        return None

    hit = _scan(_ABSOLUTE, text)
    if hit:
        rid, matched, reason = hit
        return P.HardcodedHit(rule_id=rid, severity="block",
                              reason=f"absolute forbidden: {reason}", matched=matched)

    hit = _scan(_HIGH_RISK, text)
    if hit:
        rid, matched, reason = hit
        return P.HardcodedHit(rule_id=rid, severity="review",
                              reason=f"high-risk: {reason}", matched=matched)
    return None
