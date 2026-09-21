"""Newline-delimited JSON-RPC 2.0 over stdio for the SingGuard sidecar.

Protocol (COGNITION §3):
  Request : {"id":<int|str>, "method":"classify", "params":{...}}
  Response: {"id":<id>, "ok":true,  "result":{...}}
            {"id":<id>, "ok":false, "error":{"code":<ErrorCode>, "message":...}}

stdout carries ONLY protocol JSON lines (one per message). Diagnostics go to
stderr so the Bun host's stdout reader never sees non-protocol bytes.
"""
from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable, TextIO

from . import protocol as P

Handler = Callable[[dict], Any]
"""A method handler: receives `params` (dict), returns a JSON-serializable
result or raises JsonRpcError."""


class JsonRpcError(Exception):
    def __init__(self, code: P.ErrorCode, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def write_message(stream: TextIO, obj: dict) -> None:
    stream.write(json.dumps(obj, ensure_ascii=False) + "\n")
    stream.flush()


def _ok(req_id, result) -> dict:
    return {"id": req_id, "ok": True, "result": result}


def _err(req_id, code: P.ErrorCode, message: str, data: Any = None) -> dict:
    e = {"code": code.value if isinstance(code, P.ErrorCode) else str(code),
         "message": message}
    if data is not None:
        e["data"] = data
    return {"id": req_id, "ok": False, "error": e}


def serve(handlers: dict, stdin: TextIO, stdout: TextIO, stderr: TextIO,
          on_shutdown: Callable[[], None] | None = None) -> None:
    """Run the read/dispatch loop. Blocks until stdin closes or shutdown.

    `handlers` maps method name -> Handler(params)->result.
    """
    for raw in stdin:
        raw = raw.strip()
        if not raw:
            continue
        req_id = None
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError as e:
            # No id to echo back; emit a notification-less error.
            write_message(stdout, _err(None, P.ErrorCode.INVALID_PARAMS,
                                       "malformed JSON"))
            continue
        if not isinstance(msg, dict):
            write_message(stdout, _err(None, P.ErrorCode.INVALID_PARAMS,
                                       "request must be a JSON object"))
            continue
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if method == P.METHOD_SHUTDOWN:
            write_message(stdout, _ok(req_id, {"stopped": True}))
            if on_shutdown:
                on_shutdown()
            return
        handler = handlers.get(method)
        if handler is None:
            write_message(stdout, _err(req_id, P.ErrorCode.METHOD_NOT_FOUND,
                                       f"unknown method: {method!r}"))
            continue
        try:
            result = handler(params)
            write_message(stdout, _ok(req_id, result))
        except JsonRpcError as e:
            write_message(stdout, _err(req_id, e.code, "request rejected"))
        except (ValueError, TypeError, KeyError) as e:
            write_message(stdout, _err(req_id, P.ErrorCode.INVALID_PARAMS,
                                       "invalid parameters"))
        except Exception as e:  # noqa: BLE001
            stderr.write(f"[rpc] handler failed (method category; error-length={len(str(e))})\n")
            stderr.flush()
            write_message(stdout, _err(req_id, P.ErrorCode.INTERNAL_ERROR,
                                       "internal error"))
