"""Download SingGuard-NSFA-0.8B into <repo>/model (or $SG_MODEL_PATH).

Run:  conda run -n Audio python guard/download_model.py

Weights are Apache-2.0 (inclusionAI/SingGuard-NSFA-0.8B) and are gitignored.
This script is the supported way to obtain them; do not vendor the ~2GB
checkpoint into git.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

MODEL_ID = "inclusionAI/SingGuard-NSFA-0.8B"
_REPO_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DIR = os.environ.get("SG_MODEL_PATH") or str(_REPO_ROOT / "model")

print(f"[download] model_id={MODEL_ID}", flush=True)
print(f"[download] local_dir={LOCAL_DIR}", flush=True)

try:
    from modelscope import snapshot_download
except Exception as e:
    print(f"[download] ERROR importing modelscope: {e}", flush=True)
    sys.exit(1)

try:
    path = snapshot_download(
        MODEL_ID,
        local_dir=LOCAL_DIR,
    )
    print(f"[download] OK -> {path}", flush=True)
except Exception as e:
    print(f"[download] FAILED: {type(e).__name__}: {e}", flush=True)
    # Fallback: huggingface_hub, optionally via a mirror.
    try:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        from huggingface_hub import snapshot_download as hf_dl
        path = hf_dl(MODEL_ID, local_dir=LOCAL_DIR)
        print(f"[download] OK via huggingface_hub -> {path}", flush=True)
    except Exception as e2:
        print(f"[download] huggingface_hub also failed: {type(e2).__name__}: {e2}", flush=True)
        sys.exit(2)

if os.path.isdir(LOCAL_DIR):
    print("[download] contents:", flush=True)
    for name in sorted(os.listdir(LOCAL_DIR)):
        full = os.path.join(LOCAL_DIR, name)
        size = os.path.getsize(full) if os.path.isfile(full) else "<dir>"
        print(f"  {name}  {size}", flush=True)
    heads = os.path.join(LOCAL_DIR, "nsfa_heads")
    if os.path.isdir(heads):
        print("[download] nsfa_heads:", flush=True)
        for h in sorted(os.listdir(heads)):
            print(f"  {h}  {os.path.getsize(os.path.join(heads, h))}", flush=True)
