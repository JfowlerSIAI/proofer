"""Stdlib-only security regression tests; no model imports or downloads."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from secure_model import ModelSecurityError, PINS, default_encoder_dir, prepare_model


class ModelSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="proofer-encoder-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.model = self.root / "source-model"
        self.encoder = self.root / "source-encoder"
        self.pins = {"model": {}, "encoder": {}}
        for group, root in [("model", self.model), ("encoder", self.encoder)]:
            for name in PINS[group]:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                data = (json.dumps({"encoder_name": "mutable/upstream"}) if name.endswith("config.json")
                        else "pinned test bytes: " + name).encode()
                target.write_bytes(data)
                self.pins[group][name] = hashlib.sha256(data).hexdigest()
        self.environment = patch.dict(os.environ, {}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def prepare(self):
        result = prepare_model(self.model, self.encoder, pins=self.pins)
        self.addCleanup(result.close)
        return result

    def test_both_nested_encoder_references_are_local_and_verified(self):
        before = (self.model / "config.json").read_bytes()
        (self.model / "unreviewed.py").write_text("raise RuntimeError('must never execute')")
        os.environ["HF_HUB_OFFLINE"] = "0"
        os.environ["TRANSFORMERS_OFFLINE"] = "0"
        os.environ["HF_MODULES_CACHE"] = str(self.root / "untrusted-module-cache")
        result = self.prepare()
        for name in ["config.json", "reranker/scorer_config.json"]:
            config = json.loads((result.directory / name).read_text())
            encoder = Path(config["encoder_name"])
            self.assertEqual(encoder, result.directory.parent / "encoder")
            self.assertEqual(hashlib.sha256((encoder / "modeling_lfm2_bidirectional.py").read_bytes()).hexdigest(),
                             self.pins["encoder"]["modeling_lfm2_bidirectional.py"])
        self.assertEqual((self.model / "config.json").read_bytes(), before)
        self.assertFalse((result.directory / "unreviewed.py").exists())
        self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
        self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
        self.assertEqual(list(Path(os.environ["HF_MODULES_CACHE"]).iterdir()), [])
        self.assertEqual(Path(os.environ["HF_MODULES_CACHE"]).parent, result.directory.parent)

    def test_modified_code_config_and_weights_fail_before_import(self):
        for group, root in [("model", self.model), ("encoder", self.encoder)]:
            for name in self.pins[group]:
                with self.subTest(group=group, name=name):
                    asset = root / name
                    original = asset.read_bytes()
                    asset.write_bytes(original + b"unreviewed modification")
                    try:
                        with self.assertRaisesRegex(ModelSecurityError, "SHA-256 mismatch"):
                            self.prepare()
                    finally:
                        asset.write_bytes(original)
        self.assertNotIn("transformers", sys.modules)
        self.assertNotIn("huggingface_hub", sys.modules)

    def test_missing_nested_code_fails_instead_of_downloading(self):
        (self.encoder / "modeling_lfm2_bidirectional.py").unlink()
        with self.assertRaisesRegex(ModelSecurityError, "Missing or non-regular pinned model asset"):
            self.prepare()
        with self.assertRaisesRegex(ModelSecurityError, "downloads are disabled"):
            prepare_model(self.model, self.root / "absent", pins=self.pins)

    def test_preimported_hub_library_cannot_bypass_offline_initialization(self):
        with patch.dict(sys.modules, {"huggingface_hub": types.ModuleType("huggingface_hub")}):
            with self.assertRaisesRegex(ModelSecurityError, "before importing"):
                self.prepare()

    def test_default_snapshot_uses_fixed_revision_not_main(self):
        with patch.dict(os.environ, {"HF_HUB_CACHE": str(self.root / "hub")}):
            directory = default_encoder_dir()
        self.assertEqual(directory.name, "b886781f7c6f10ca9b7096e21b83e30a073c2f39")
        self.assertEqual(directory.parent.name, "snapshots")


if __name__ == "__main__":
    unittest.main()
