#!/usr/bin/env python3
# loader-cli.py — CLI wrapper around businesses.lib.loader, sys.path-safe.
#
# Why: brief-business.ts previously embedded a Python script inline as a
# string and passed it via `python3 -c "..."`. Depending on cwd, the
# sys.path.insert didn't resolve and the import failed silently, returning
# "(unknown)" as the intake employee. This wrapper guarantees the loader is
# importable regardless of where bun invokes us from.
#
# Usage:
#   python3 loader-cli.py <business_dir> --field intake_employee
#   python3 loader-cli.py <business_dir> --field employees
#   python3 loader-cli.py <business_dir> --field all
#
# Exit 0 on success. Exit 1 if business_dir is not loadable.

import argparse
import json
import os
import sys

SKILL_LIB = os.path.expanduser("~/.claude/skills/businesses/lib")
if SKILL_LIB not in sys.path:
    sys.path.insert(0, SKILL_LIB)


def main() -> int:
    p = argparse.ArgumentParser(prog="loader-cli")
    p.add_argument("business_dir", help="Path to a business directory")
    p.add_argument(
        "--field",
        default="all",
        choices=["intake_employee", "all", "employees", "name"],
        help="What to print",
    )
    args = p.parse_args()

    try:
        from loader import load_business
    except Exception as e:
        print(f"loader import failed: {e}", file=sys.stderr)
        return 1

    try:
        biz = load_business(args.business_dir)
    except Exception as e:
        print(f"load_business failed: {e}", file=sys.stderr)
        return 1

    if args.field == "intake_employee":
        for e in biz.employees:
            if getattr(e, "is_brief_intake", False):
                print(e.name)
                return 0
        # No intake declared — print empty line, exit 0 (caller decides).
        print("")
        return 0

    if args.field == "name":
        print(biz.name)
        return 0

    if args.field == "employees":
        payload = [
            {
                "name": e.name,
                "is_brief_intake": getattr(e, "is_brief_intake", False),
            }
            for e in biz.employees
        ]
        print(json.dumps(payload))
        return 0

    # field == "all"
    payload = {
        "name": biz.name,
        "employees": [
            {
                "name": e.name,
                "is_brief_intake": getattr(e, "is_brief_intake", False),
            }
            for e in biz.employees
        ],
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
