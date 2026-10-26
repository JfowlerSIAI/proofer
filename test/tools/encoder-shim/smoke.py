import atexit, json, os, time, sys
from secure_model import ModelSecurityError, prepare_model

MODEL_DIR = os.environ.get("PROOFER_ENCODER_DIR", os.path.expanduser("~/models/LFM2.5-Encoder-350M-Spellchecker"))
t0 = time.time()
try:
    assets = prepare_model(MODEL_DIR)
except ModelSecurityError as error:
    raise SystemExit(f"Encoder security check failed: {error}")
atexit.register(assets.close)
from transformers import AutoModel
model = AutoModel.from_pretrained(str(assets.directory), trust_remote_code=True,
                                  local_files_only=True).float().eval()
print(f"loaded in {time.time()-t0:.1f}s", flush=True)

examples = json.loads((assets.directory / "examples.json").read_text())
srcs = [e["source"] for e in examples]
t0 = time.time()
out = model.correct(srcs)
print(f"correct() on {len(srcs)} tokenized examples: {time.time()-t0:.2f}s")
for e, o in zip(examples, out):
    mark = "OK " if o == e["corrected"] else "DIFF"
    print(f"  [{mark}] {e['source']!r} -> {o!r} (want {e['corrected']!r})")

# The real question: what does it do with NORMAL (untokenized) text?
raw = [
    "She go to school every day.",
    "I has went to the stor yesterday.",
    "The techncian arrived early.",
    "We recieved the invoice, but the amount was wrong.",
    "yeah that works for me",
    "The sample label refers to that emtal.",
    "the the report is done.",
]
t0 = time.time()
out2 = model.correct(raw)
print(f"\ncorrect() on {len(raw)} RAW sentences: {time.time()-t0:.2f}s")
for s, o in zip(raw, out2):
    print(f"  {s!r} -> {o!r}")
