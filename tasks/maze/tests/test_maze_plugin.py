import tempfile
import unittest
from pathlib import Path
from canvas.registry import load_runtime, tasks


class MazePluginTests(unittest.TestCase):
    def setUp(self):
        self.task = next(task for task in tasks() if task["id"] == "maze")
        self.runtime = load_runtime(self.task)

    def test_standalone_prompt_explains_both_files_and_scoring(self):
        payload = self.runtime.build_payload(self.task)
        for required in ("strategy.js", "hunter.js", "README.md", "invulnerableUntil", "hunterEvery", "32768", "200ms", "6000", "整轮作废"):
            self.assertIn(required, payload["prompt_text"])

    def test_hunter_file_is_required_without_registration_or_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / "revisions/v1"
            folder.mkdir(parents=True)
            (folder / "strategy.js").write_text("function decide(){return {action:'wait'}}", encoding="utf-8")
            manifest = {"revisions": [{"id": "v1", "directory": "revisions/v1"}]}
            with self.assertRaisesRegex(ValueError, "hunter.js"):
                self.runtime.validate(self.task, [(root, manifest)])
            (folder / "hunter.js").write_text("function decide(o){return {actions:[]}}", encoding="utf-8")
            self.runtime.validate(self.task, [(root, manifest)])
            manifest["revisions"][0]["prompt_sha256"] = "stale"
            self.runtime.validate(self.task, [(root, manifest)])
