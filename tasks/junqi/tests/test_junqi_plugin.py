import tempfile
import unittest
from pathlib import Path
from canvas.registry import load_runtime, tasks


class JunqiPluginTests(unittest.TestCase):
    def setUp(self):
        self.task = next(t for t in tasks() if t['id'] == 'junqi')
        self.runtime = load_runtime(self.task)

    def test_prompt_contains_current_rules(self):
        text = self.runtime.build_payload(self.task)['prompt_text']
        for token in ('junqi-2', 'strategy.js', 'README.md', '32768', '1000ms', '3000ms',
                      'floor(tick / 200)', '(8+2N)', '(11+3N)', '4N+4', '4000', '1500'):
            self.assertIn(token, text)

    def test_source_required_and_byte_limit_enforced(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            entries = [(base, {'revisions': [{'directory': '.'}]})]
            with self.assertRaisesRegex(ValueError, 'strategy.js'):
                self.runtime.validate(self.task, entries)
            source = base / 'strategy.js'
            source.write_bytes(b'x' * 100000)
            self.runtime.validate(self.task, entries)
            source.write_bytes(b'x' * 100001)
            with self.assertRaisesRegex(ValueError, '100000'):
                self.runtime.validate(self.task, entries)
