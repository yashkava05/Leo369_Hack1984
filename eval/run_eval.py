"""Run the pipeline over eval/screenshots and compare against eval/expected.json.

Stub: the eval set issue fills in the screenshots, expectations, and scoring.
"""

import json
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent


def main() -> None:
    expected = json.loads((EVAL_DIR / "expected.json").read_text())
    print(f"Loaded {len(expected)} expected cases; evaluation not implemented yet.")


if __name__ == "__main__":
    main()
