"""Discover task-owned tests through the same plugin directory convention."""
from pathlib import Path
from canvas.registry import tasks,task_root

def load_tests(loader,standard_tests,pattern):
    for task in tasks():
        folder=task_root(task)/"tests"
        if folder.is_dir():
            standard_tests.addTests(loader.discover(str(folder),pattern="test_*.py",top_level_dir=str(folder)))
    return standard_tests
