import importlib
import importlib.util
import sys
import unittest
from pathlib import Path

# Ensure target file directory is on sys.path for direct imports
_target_rel = 'deliverable.py'
_this_dir = Path(__file__).resolve().parent
_target_path = _this_dir / _target_rel
if _target_path.exists():
    _parent_dir = str(_target_path.parent)
    if _parent_dir not in sys.path:
        sys.path.insert(0, _parent_dir)

class TestDeliverable(unittest.TestCase):
    def test_module_import_and_exports(self):
        mod = None
        try:
            mod = importlib.import_module('deliverable')
        except Exception:
            if _target_path.exists():
                spec = importlib.util.spec_from_file_location('deliverable', str(_target_path))
                if spec and spec.loader:
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
            if mod is None:
                try:
                    mod = importlib.import_module('deliverable')
                except Exception:
                    pass

        self.assertIsNotNone(mod, f"Failed to import target module 'deliverable' from {_target_rel}")
        exported = [n for n in dir(mod) if not n.startswith('_')]
        self.assertGreater(len(exported), 0, "Module 'deliverable' must expose at least one substantive public entity.")
        if hasattr(mod, 'solution') and callable(getattr(mod, 'solution')):
            res = mod.solution()
            self.assertIsNotNone(res)

if __name__ == '__main__':
    unittest.main()
