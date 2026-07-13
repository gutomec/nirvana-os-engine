#!/usr/bin/env python3
"""
businesses skill · loader

Carrega uma business inteira (manifest + employees + org-chart + routing) e
roda validação cruzada. Reusa os validators centralizados em
~/.claude/skills/_shared/validators/validators.py.

Use:
    from lib.loader import load_business, ValidationError
    biz = load_business('~/businesses/my-startup')
    print(biz.manifest.name, len(biz.employees))

ou via CLI:
    python3 lib/loader.py ~/businesses/my-startup
"""
from __future__ import annotations

import os
import re
import sys
import yaml
from dataclasses import dataclass
from pathlib import Path

# Importa validators centralizados
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
    """Raised quando uma business falha validação."""

    def __init__(self, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or []


@dataclass
class LoadedBusiness:
    """Container de business carregada e validada."""

    path: Path
    manifest: BusinessManifest
    employees: list[EmployeeFrontmatter]
    org_chart: OrgChart
    routing: Routing | None
    permanent_memory_path: Path | None


def _expand(p: str | Path) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p)))).resolve()


def _read_frontmatter_md(path: Path) -> tuple[dict, str]:
    """Lê arquivo .md, retorna (frontmatter dict, body)."""
    raw = path.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', raw, flags=re.DOTALL)
    if not m:
        raise ValidationError(f'Frontmatter ausente ou malformado em {path}')
    fm_yaml = m.group(1)
    body = m.group(2)
    fm = yaml.safe_load(fm_yaml)
    if not isinstance(fm, dict):
        raise ValidationError(f'Frontmatter de {path} deve ser mapping')
    return fm, body


def load_business(path: str | Path, *, strict: bool = True) -> LoadedBusiness:
    """Carrega business completa de um diretório.

    Estrutura esperada:
        <path>/business.yaml
        <path>/employees/*.md
        <path>/org-chart.yaml
        <path>/routing.yaml         (opcional)
        <path>/escalation-triggers.yaml (opcional)
        <path>/memory/permanent.md  (opcional)

    Quando strict=True (default), lança ValidationError se algo está inválido.
    Quando strict=False, retorna a business com erros acumulados (raise apenas
    em erros fatais como manifest ausente).
    """
    biz_path = _expand(path)
    if not biz_path.is_dir():
        raise ValidationError(f'Diretório não encontrado: {biz_path}')

    errors: list[str] = []

    # 1. Manifest (obrigatório)
    manifest_path = biz_path / 'business.yaml'
    if not manifest_path.is_file():
        raise ValidationError(f'business.yaml ausente em {biz_path}')

    manifest_data = yaml.safe_load(manifest_path.read_text(encoding='utf-8'))
    try:
        manifest = BusinessManifest.model_validate(manifest_data)
    except Exception as exc:
        raise ValidationError(f'business.yaml inválido: {exc}') from exc

    # 2. Org chart (obrigatório)
    chart_path = biz_path / 'org-chart.yaml'
    if not chart_path.is_file():
        raise ValidationError(f'org-chart.yaml ausente em {biz_path}')

    chart_data = yaml.safe_load(chart_path.read_text(encoding='utf-8'))
    try:
        org_chart = OrgChart.model_validate(chart_data)
    except Exception as exc:
        raise ValidationError(f'org-chart.yaml inválido: {exc}') from exc

    # 3. Employees (obrigatório, ≥1)
    employees_dir = biz_path / 'employees'
    if not employees_dir.is_dir():
        raise ValidationError(f'employees/ ausente em {biz_path}')

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
        raise ValidationError(f'employees/ vazio em {biz_path}')

    # 4. Routing (opcional, documentação)
    # routing.yaml não é a fonte de verdade do roteamento em runtime: o router
    # consome auto_routes via registry._read_routing (que faz parse tolerante de
    # business.yaml + routing.yaml). Logo, um routing.yaml que não bate com o
    # schema canônico (formatos mais ricos: routing_rules, approval_gates, etc.)
    # NÃO deve invalidar uma business correta. Mantemos como warning.
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

    # 6. Cross-protocol integrity check (BP7, intake único, sem ciclos, etc.)
    ctx = BusinessLoadContext(manifest=manifest, employees=employees, org_chart=org_chart)
    result = validate_business_integrity(ctx)
    if not result.valid:
        if strict:
            raise ValidationError(
                f'Integrity check falhou em {biz_path}', errors=result.errors
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
