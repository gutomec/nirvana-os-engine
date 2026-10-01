#!/usr/bin/env python3
"""
businesses skill · loader

Loads a whole business (manifest + employees + org-chart + routing) and
runs cross-validation. Reuses the centralized validators in
~/.claude/skills/_shared/validators/validators.py.

Usage:
    from lib.loader import load_business, ValidationError
    biz = load_business('~/businesses/my-startup')
    print(biz.manifest.name, len(biz.employees))

or via CLI:
    python3 lib/loader.py ~/businesses/my-startup
"""
from __future__ import annotations

import os
import re
import sys
import yaml
from dataclasses import dataclass
from pathlib import Path

# Import the centralized validators
SHARED_VALIDATORS = os.path.expanduser('~/.claude/skills/_shared/validators')
if SHARED_VALIDATORS not in sys.path:
    sys.path.insert(0, SHARED_VALIDATORS)

from validators import (  # type: ignore[import-not-found]
    BusinessManifest,
    EmployeeFrontmatter,
    OrgChart,
    Routing,
    BusinessLoadContext,
    validate_business_integrity,
)


class ValidationError(Exception):
    """Raised when a business fails validation."""

    def __init__(self, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or []


@dataclass
class LoadedBusiness:
    """Container for a loaded, validated business."""

    path: Path
    manifest: BusinessManifest
    employees: list[EmployeeFrontmatter]
    org_chart: OrgChart
    routing: Routing | None
    permanent_memory_path: Path | None


def _expand(p: str | Path) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p)))).resolve()


def _read_frontmatter_md(path: Path) -> tuple[dict, str]:
    """Read a .md file, return (frontmatter dict, body)."""
    raw = path.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', raw, flags=re.DOTALL)
    if not m:
        raise ValidationError(f'Frontmatter missing or malformed in {path}')
    fm_yaml = m.group(1)
    body = m.group(2)
    fm = yaml.safe_load(fm_yaml)
    if not isinstance(fm, dict):
        raise ValidationError(f'Frontmatter of {path} must be a mapping')
    return fm, body


def load_business(path: str | Path, *, strict: bool = True) -> LoadedBusiness:
    """Load a complete business from a directory.

    Estrutura esperada:
        <path>/business.yaml
        <path>/employees/*.md
        <path>/org-chart.yaml
        <path>/routing.yaml         (opcional)
        <path>/escalation-triggers.yaml (opcional)
        <path>/memory/permanent.md  (opcional)

    When strict=True (default), raises ValidationError if anything is invalid.
    When strict=False, returns the business with accumulated errors (raises
    only on fatal errors such as a missing manifest).
    """
    biz_path = _expand(path)
    if not biz_path.is_dir():
        raise ValidationError(f'Directory not found: {biz_path}')

    errors: list[str] = []

    # 1. Manifest (required)
    manifest_path = biz_path / 'business.yaml'
    if not manifest_path.is_file():
        raise ValidationError(f'business.yaml missing in {biz_path}')

    manifest_data = yaml.safe_load(manifest_path.read_text(encoding='utf-8'))
    try:
        manifest = BusinessManifest.model_validate(manifest_data)
    except Exception as exc:
        raise ValidationError(f'invalid business.yaml: {exc}') from exc

    # 2. Org chart (required)
    chart_path = biz_path / 'org-chart.yaml'
    if not chart_path.is_file():
        raise ValidationError(f'org-chart.yaml missing in {biz_path}')

    chart_data = yaml.safe_load(chart_path.read_text(encoding='utf-8'))
    try:
        org_chart = OrgChart.model_validate(chart_data)
    except Exception as exc:
        raise ValidationError(f'invalid org-chart.yaml: {exc}') from exc

    # 3. Employees (required, at least 1)
    employees_dir = biz_path / 'employees'
    if not employees_dir.is_dir():
        raise ValidationError(f'employees/ missing in {biz_path}')

    employees: list[EmployeeFrontmatter] = []
    for emp_file in sorted(employees_dir.glob('*.md')):
        try:
            fm, _body = _read_frontmatter_md(emp_file)
            employees.append(EmployeeFrontmatter.model_validate(fm))
        except (ValidationError, Exception) as exc:
            err = f'employee {emp_file.name}: {exc}'
            if strict:
                raise ValidationError(err) from exc
            errors.append(err)

    if not employees and strict:
        raise ValidationError(f'employees/ empty in {biz_path}')

    # 4. Routing (optional, documentation)
    # routing.yaml is not the source of truth for runtime routing: the router
    # consumes auto_routes via registry._read_routing (which parses
    # business.yaml + routing.yaml tolerantly). So a routing.yaml that does not
    # match the canonical schema (richer formats: routing_rules, approval_gates,
    # etc.) must NOT invalidate a correct business. We keep it as a warning.
    routing: Routing | None = None
    routing_path = biz_path / 'routing.yaml'
    if routing_path.is_file():
        routing_data = yaml.safe_load(routing_path.read_text(encoding='utf-8'))
        try:
            routing = Routing.model_validate(routing_data)
        except Exception:
            routing = None

    # 5. Permanent memory path (opcional)
    permanent_memory_path: Path | None = None
    permanent_md = biz_path / 'memory' / 'permanent.md'
    if permanent_md.is_file():
        permanent_memory_path = permanent_md

    # 6. Cross-protocol integrity check (BP7, single intake, no cycles, etc.)
    ctx = BusinessLoadContext(manifest=manifest, employees=employees, org_chart=org_chart)
    result = validate_business_integrity(ctx)
    if not result.valid:
        if strict:
            raise ValidationError(
                f'Integrity check failed in {biz_path}', errors=result.errors
            )
        errors.extend(result.errors)

    if errors and strict:
        raise ValidationError(f'Business {manifest.name} tem erros', errors=errors)

    return LoadedBusiness(
        path=biz_path,
        manifest=manifest,
        employees=employees,
        org_chart=org_chart,
        routing=routing,
        permanent_memory_path=permanent_memory_path,
    )


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print('Usage: python3 loader.py <business-path>', file=sys.stderr)
        return 2

    path = argv[1]
    try:
        biz = load_business(path)
    except ValidationError as exc:
        print(f'INVALID: {exc}', file=sys.stderr)
        for err in exc.errors:
            print(f'  - {err}', file=sys.stderr)
        return 1

    print(f'OK: {biz.manifest.name} v{biz.manifest.version}')
    print(f'  protocol: {biz.manifest.protocol}')
    print(f'  domains: {biz.manifest.domains}')
    print(f'  employees: {len(biz.employees)}')
    intake = next((e for e in biz.employees if e.is_brief_intake), None)
    print(f'  brief_intake: {intake.name if intake else "<NONE>"}')
    antagonists = [e.name for e in biz.employees if e.is_antagonist]
    print(f'  antagonists: {antagonists or "<none>"}')
    org_chart_nodes = len(biz.org_chart.chart) if (biz.org_chart and biz.org_chart.chart) else 0
    print(f'  org_chart nodes: {org_chart_nodes}')
    print(f'  routing: {"present" if biz.routing else "absent"}')
    print(f'  permanent_memory: {biz.permanent_memory_path or "<none>"}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
