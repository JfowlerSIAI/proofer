"""Prepare the reviewed encoder assets without executing model or library code.

Both entry points call this before importing Transformers. Only pinned bytes are
copied into the private staging tree; neither mutable Hub refs nor an existing
dynamic-module cache can choose the code that will execute.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


PINS = json.loads(Path(__file__).with_name("model-pins.json").read_text())


class ModelSecurityError(RuntimeError):
    pass


def default_encoder_dir():
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface"))
    hub = Path(os.environ.get("HF_HUB_CACHE", hf_home / "hub"))
    return hub / "models--LiquidAI--LFM2.5-Encoder-350M" / "snapshots" / PINS["encoder_revision"]


def _copy_verified(source, destination, expected):
    """Hash the bytes actually copied, including the weights and pickle."""
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        if not source.is_file():
            raise ModelSecurityError(f"Missing or non-regular pinned model asset: {source}")
        with source.open("rb") as incoming:
            if not stat.S_ISREG(os.fstat(incoming.fileno()).st_mode):
                raise ModelSecurityError(f"Not a regular model file: {source}")
            digest = hashlib.sha256()
            with destination.open("xb") as outgoing:
                os.chmod(destination, 0o600)
                for block in iter(lambda: incoming.read(1024 * 1024), b""):
                    digest.update(block)
                    outgoing.write(block)
    except OSError as error:
        raise ModelSecurityError(f"Cannot read pinned model asset {source}: {error.strerror}") from error
    if digest.hexdigest() != expected:
        raise ModelSecurityError(f"SHA-256 mismatch for {source}; restore the reviewed asset, do not re-pin automatically")


class PreparedModel:
    def __init__(self, temporary):
        self._temporary = temporary
        self.directory = Path(temporary.name) / "spellchecker"

    def close(self):
        self._temporary.cleanup()
        # Offline flags deliberately remain set for any already imported Hub
        # libraries. The process must not regain online behavior after loading.


def prepare_model(model_dir, encoder_dir=None, *, pins=None):
    """Fail closed before model execution; never download or alter source assets."""
    if any(name == "transformers" or name.startswith("transformers.") or
           name == "huggingface_hub" or name.startswith("huggingface_hub.") for name in sys.modules):
        raise ModelSecurityError("Prepare the pinned model before importing Transformers or huggingface_hub")
    pins = PINS if pins is None else pins
    model_dir = Path(model_dir).expanduser().resolve()
    encoder_dir = Path(encoder_dir or os.environ.get("PROOFER_ENCODER_BASE_DIR", default_encoder_dir())).expanduser().resolve()
    if not model_dir.is_dir() or not encoder_dir.is_dir():
        raise ModelSecurityError(
            "Pinned local model assets are missing. Set PROOFER_ENCODER_DIR and "
            "PROOFER_ENCODER_BASE_DIR to the reviewed snapshots described in README.md; downloads are disabled")
    temporary = tempfile.TemporaryDirectory(prefix="proofer-encoder-")
    staging = Path(temporary.name)
    try:
        for group, source, directory in [("model", model_dir, "spellchecker"), ("encoder", encoder_dir, "encoder")]:
            for relative, expected in pins[group].items():
                rel = Path(relative)
                if rel.is_absolute() or ".." in rel.parts or "\\" in relative:
                    raise ModelSecurityError("Invalid path in model pin manifest")
                _copy_verified(source / rel, staging / directory / rel, expected)
        # The nested model and reranker each resolve an encoder independently.
        # Rewrite both verified configs in the private copy to the verified local
        # snapshot. Merely setting local_files_only on the outer load is not enough.
        for relative in ["config.json", "reranker/scorer_config.json"]:
            config_path = staging / "spellchecker" / relative
            config = json.loads(config_path.read_text())
            config["encoder_name"] = str(staging / "encoder")
            config_path.write_text(json.dumps(config) + "\n")
        modules = staging / "modules"
        modules.mkdir(mode=0o700)
        environment = {
            "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1", "HF_MODULES_CACHE": str(modules),
        }
        os.environ.update(environment)
        return PreparedModel(temporary)
    except BaseException:
        temporary.cleanup()
        raise
