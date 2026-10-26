# Ollama-/api/chat-compatible shim around LFM2.5-Encoder-350M-Spellchecker.correct().
# The Proofer sentence suites send the target sentence bare as the LAST user turn;
# everything else (system prompt, few-shot, context) is generative-model scaffolding
# the encoder cannot read, so the shim ignores it. That asymmetry is a finding, not
# a bug: sentence-context-test measures exactly what ignoring context costs
# (measured 2026-08-20: flat 21/24 across none/implied/stated).
#
# Usage:
#   <venv>/bin/python shim.py            # serves 127.0.0.1:11500
#   PROOFER_OLLAMA_URL=http://127.0.0.1:11500 PROOFER_MODEL=lfm2.5-spellchecker-encoder \
#     node sentence-owner-bench.mjs --corpus random-holdout.json --tag encoder
# Env: PROOFER_ENCODER_DIR (model dir), PROOFER_ENCODER_PORT (default 11500).
# See README.md here for the pinned environment and model hashes.
import atexit, json, os, re, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from secure_model import ModelSecurityError, prepare_model

MODEL_DIR = os.environ.get(
    "PROOFER_ENCODER_DIR",
    os.path.expanduser("~/models/LFM2.5-Encoder-350M-Spellchecker"))
PORT = int(os.environ.get("PROOFER_ENCODER_PORT", "11500"))

print("loading model...", flush=True)
try:
    assets = prepare_model(MODEL_DIR)
except ModelSecurityError as error:
    raise SystemExit(f"Encoder security check failed: {error}")
atexit.register(assets.close)
from transformers import AutoModel
model = AutoModel.from_pretrained(str(assets.directory), trust_remote_code=True,
                                  local_files_only=True).float().eval()
print("model ready", flush=True)


def detok(s: str) -> str:
    """Undo GECToR-style tokenization the model leaks on INSERTED tokens.
    Raw input mostly round-trips untokenized; only new punctuation/contractions
    come out detached ('Yeah , that works .'). Minimal joins only."""
    s = re.sub(r" (n't)\b", r"\1", s)
    s = re.sub(r" ('s|'re|'ve|'ll|'d|'m)\b", r"\1", s)
    s = re.sub(r" ([,.!?;:%])(?=\s|$)", r"\1", s)
    s = re.sub(r"\( ", "(", s)
    s = re.sub(r" \)", ")", s)
    return s


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/tags"):
            self._json(200, {"models": [{"name": "lfm2.5-spellchecker-encoder",
                                         "model": "lfm2.5-spellchecker-encoder",
                                         "digest": "shim", "size": 713449656}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/api/chat"):
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"error": f"bad request: {e}"})
        msgs = req.get("messages") or []
        users = [m for m in msgs if m.get("role") == "user"]
        if not users:  # warmup shape: empty messages = pure load
            return self._json(200, {"model": req.get("model"), "done": True,
                                    "done_reason": "load"})
        sentence = str(users[-1].get("content", ""))
        t0 = time.time_ns()
        try:
            corrected = detok(model.correct([sentence])[0])
        except Exception as e:
            return self._json(200, {"error": f"correct() failed: {e}"})
        dur = time.time_ns() - t0
        self._json(200, {
            "model": req.get("model"), "created_at": "",
            "message": {"role": "assistant",
                        "content": json.dumps({"rewritten": corrected})},
            "done": True, "done_reason": "stop",
            "total_duration": dur, "load_duration": 0,
            "prompt_eval_count": max(1, len(sentence) // 4),
            "prompt_eval_duration": 0,
            "eval_count": max(1, len(corrected) // 4),
            "eval_duration": dur,
        })


print(f"listening on 127.0.0.1:{PORT}", flush=True)
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
