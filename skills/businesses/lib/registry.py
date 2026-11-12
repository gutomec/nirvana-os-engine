#!/usr/bin/env python3
"""
businesses skill · registry

Indexer that scans ~/businesses/ (and extra directories) and generates
~/.businesses-registry.json. Schema: core-schemas.json#/registry_businesses.

Use:
    python3 lib/registry.py rebuild
    python3 lib/registry.py rebuild --roots ~/businesses ~/work-businesses
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Reusa loader local
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from loader import load_business, ValidationError  # type: ignore[import-not-found]

# Import the centralized validators (to validate the final registry)
SHARED_VALIDATORS = os.path.expanduser('~/.claude/skills/_shared/validators')
if SHARED_VALIDATORS not in sys.path:
    sys.path.insert(0, SHARED_VALIDATORS)
from validators import RegistryBusinesses  # type: ignore[import-not-found]


def _resolve_default_registry_path() -> str:
    """Scope-aware resolution mirroring paths.js / scope.ts.

    Priority: env BUSINESSES_REGISTRY_PATH > project-scoped path > global default.
    Project mode is detected by walking up from cwd looking for .env / .nirvana
    / .git, then reading NIRVANA_SCOPE from the .env file if present.
    """
    env_override = os.environ.get('BUSINESSES_REGISTRY_PATH')
    if env_override:
        return env_override
    cur = Path(os.getcwd()).resolve()
    project_root = None
    for _ in range(30):
        for marker in ('.env', '.nirvana', '.git', 'package.json', 'pyproject.toml'):
            if (cur / marker).exists():
                project_root = cur
                break
        if project_root or cur.parent == cur:
            break
        cur = cur.parent
    mode = (os.environ.get('NIRVANA_SCOPE') or '').lower()
    if not mode and project_root and (project_root / '.env').exists():
        for line in (project_root / '.env').read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line.startswith('NIRVANA_SCOPE='):
                mode = line.split('=', 1)[1].strip().strip('"\'').lower()
                break
    if mode == 'project' and project_root:
        return str(project_root / '.nirvana' / '.businesses-registry.json')
    return os.path.expanduser('~/.businesses-registry.json')


DEFAULT_REGISTRY_PATH = _resolve_default_registry_path()
DEFAULT_ROOTS = [os.path.expanduser('~/businesses')]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return f'sha256:{h.hexdigest()}'


def _is_business_dir(d: Path) -> bool:
    """True if the directory looks like a business (contains business.yaml).
    Skips reserved directories such as _library, _shared, .git, etc.
    """
    if d.name.startswith('.') or d.name.startswith('_'):
        return False
    return (d / 'business.yaml').is_file()


def _normalize_auto_routes(routes: object) -> list[dict]:
    """Normalize a list of auto_routes to {pattern, route_to, ...}.
    route_to accepts the keys route_to | employee | capability (in that order).
    """
    if not isinstance(routes, list):
        return []
    out: list[dict] = []
    for r in routes:
        if not isinstance(r, dict):
            continue
        pattern = r.get('pattern')
        route_to = r.get('route_to') or r.get('employee') or r.get('capability') or r.get('to')
        if not isinstance(pattern, str) or not isinstance(route_to, str):
            continue
        entry = {'pattern': pattern, 'route_to': route_to}
        esc = r.get('requires_escalation_to')
        if isinstance(esc, str):
            entry['requires_escalation_to'] = esc
        ct = r.get('confidence_threshold')
        if ct is None:
            ct = r.get('confidence')
        if isinstance(ct, (int, float)):
            entry['confidence_threshold'] = float(ct)
        out.append(entry)
    return out


def _read_routing(child: Path) -> list[dict]:
    """Read normalized auto_routes from <biz>/business.yaml AND <biz>/routing.yaml.

    business.yaml auto_routes is the manifest's canonical source (CLAUDE.md §3);
    routing.yaml is kept for compatibility. Merges both sources,
    deduplicating by (pattern, route_to). Empty if neither declares auto_routes.
    """
    import yaml  # type: ignore[import-not-found]
    collected: list[dict] = []

    # Source 1: business.yaml auto_routes (canonical)
    biz_path = child / 'business.yaml'
    if biz_path.is_file():
        try:
            bdata = yaml.safe_load(biz_path.read_text(encoding='utf-8')) or {}
            collected.extend(_normalize_auto_routes(bdata.get('auto_routes')))
        except Exception:
            pass

    # Source 2: routing.yaml (top-level auto_routes OR routing.auto_routes)
    routing_path = child / 'routing.yaml'
    if routing_path.is_file():
        try:
            data = yaml.safe_load(routing_path.read_text(encoding='utf-8')) or {}
        except Exception:
            data = {}
        routes = data.get('auto_routes')
        if routes is None and isinstance(data.get('routing'), dict):
            routes = data['routing'].get('auto_routes')
        collected.extend(_normalize_auto_routes(routes))

    # Dedupe por (pattern, route_to), preservando ordem
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for e in collected:
        key = (e['pattern'], e['route_to'])
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def scan_roots(roots: list[str | Path]) -> list[dict]:
    """Scan roots, return the list of loaded business descriptors."""
    items: list[dict] = []
    seen_slugs: set[str] = set()
    for root in roots:
        root_path = Path(os.path.expandvars(os.path.expanduser(str(root)))).resolve()
        if not root_path.is_dir():
            continue
        for child in sorted(root_path.iterdir()):
            if not child.is_dir() or not _is_business_dir(child):
                continue
            try:
                biz = load_business(child)
            except ValidationError as exc:
                items.append({
                    'slug': child.name,
                    'path': str(child),
                    'invalid': True,
                    'error': str(exc),
                })
                continue

            slug = biz.manifest.name
            if slug in seen_slugs:
                # collision: log and keep the first
                items.append({
                    'slug': slug,
                    'path': str(child),
                    'invalid': True,
                    'error': f'Slug collision with an earlier registry entry',
                })
                continue
            seen_slugs.add(slug)

            manifest_path = child / 'business.yaml'
            items.append({
                'slug': slug,
                'path': str(child),
                'invalid': False,
                'manifest_path': str(manifest_path),
                'manifest_hash': _sha256_file(manifest_path),
                'version': biz.manifest.version,
                'protocol': biz.manifest.protocol,
                'domains': list(biz.manifest.domains),
                'capabilities': list(biz.manifest.capabilities or []),
                'employee_count': len(biz.employees),
                'operation_mode': biz.manifest.operation_mode,
                'authority_level': biz.manifest.authority_level,
                'legacy_paperclip_id': (
                    biz.manifest.legacy.paperclip_company_id
                    if biz.manifest.legacy and biz.manifest.legacy.paperclip_company_id
                    else None
                ),
                'auto_routes': _read_routing(child),
                # Agentic-discovery metadata (Business Protocol v2 §6.9, optional fields).
                # Read from manifest model (extra=allow on Pydantic; getattr falls back to None).
                'produces': list(getattr(biz.manifest, 'produces', None) or []),
                'example_briefs': list(getattr(biz.manifest, 'example_briefs', None) or []),
                'keywords': list(getattr(biz.manifest, 'keywords', None) or []),
            })
    return items


def build_registry(roots: list[str | Path]) -> dict:
    """Build the registry JSON per the RegistryBusinesses schema."""
    items = scan_roots(roots)
    valid_items = [i for i in items if not i['invalid']]
    invalid_items = [i for i in items if i['invalid']]

    businesses_map: dict[str, dict] = {}
    business_routing: dict[str, list[dict]] = {}
    for it in valid_items:
        entry = {
            'version': it['version'],
            'protocol': it['protocol'],
            'manifest_path': it['manifest_path'],
            'manifest_hash': it['manifest_hash'],
            'domains': it['domains'],
            'capabilities': it['capabilities'],
            'employee_count': it['employee_count'],
            'operation_mode': it['operation_mode'],
            'authority_level': it['authority_level'],
        }
        if it.get('legacy_paperclip_id'):
            entry['legacy_paperclip_id'] = it['legacy_paperclip_id']
        # Agentic-discovery metadata — only emit when populated (graceful degradation).
        if it.get('produces'):
            entry['produces'] = it['produces']
        if it.get('example_briefs'):
            entry['example_briefs'] = it['example_briefs']
        if it.get('keywords'):
            entry['keywords'] = it['keywords']
        businesses_map[it['slug']] = entry

        routes = it.get('auto_routes') or []
        if routes:
            business_routing[it['slug']] = routes

    registry = {
        'schema_version': '1.0.0',
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'businesses_root_dirs': [str(Path(os.path.expandvars(os.path.expanduser(str(r)))).resolve()) for r in roots],
        'businesses': businesses_map,
    }

    if invalid_items:
        # Extend with extras (non-schema); does not interfere with validation
        registry['_invalid_entries'] = invalid_items

    if business_routing:
        # Extra (non-schema) consumed by harness Stage 2 buildMatchDocs.
        # Allows routing briefs to business employees via pattern matching
        # sobre business.routing.auto_routes (ver harness/lib/router.js).
        registry['_business_routing'] = business_routing

    return registry


def write_registry(registry: dict, path: str | Path = DEFAULT_REGISTRY_PATH) -> Path:
    """Write the registry as pretty JSON. Validates against the schema first."""
    out = Path(os.path.expanduser(str(path)))
    out.parent.mkdir(parents=True, exist_ok=True)

    # Validate against the schema (without invalid_entries: that field is ours, not the schema's)
    to_validate = {k: v for k, v in registry.items() if not k.startswith('_')}
    try:
        RegistryBusinesses.model_validate(to_validate)
    except Exception as exc:
        raise ValidationError(f'Resulting registry is invalid: {exc}') from exc

    out.write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding='utf-8')
    return out


def rebuild(roots: list[str | Path] | None = None,
            output: str | Path = DEFAULT_REGISTRY_PATH) -> tuple[Path, dict]:
    """Scan + build + write in one call."""
    roots = roots or DEFAULT_ROOTS
    registry = build_registry(roots)
    path = write_registry(registry, output)
    return path, registry


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='businesses registry indexer')
    sub = parser.add_subparsers(dest='cmd', required=True)

    rb = sub.add_parser('rebuild', help='Reindex businesses')
    rb.add_argument('--roots', nargs='+', default=DEFAULT_ROOTS,
                    help='Directories to scan (default: ~/businesses)')
    rb.add_argument('--output', default=DEFAULT_REGISTRY_PATH,
                    help='Registry JSON path (default: ~/.businesses-registry.json)')
    rb.add_argument('--quiet', action='store_true')

    sh = sub.add_parser('scan', help='Scan only, without writing')
    sh.add_argument('--roots', nargs='+', default=DEFAULT_ROOTS)

    args = parser.parse_args(argv[1:])

    if args.cmd == 'rebuild':
        try:
            path, registry = rebuild(args.roots, args.output)
        except ValidationError as exc:
            print(f'FAIL: {exc}', file=sys.stderr)
            return 1
        valid = len(registry['businesses'])
        invalid = len(registry.get('_invalid_entries', []))
        if not args.quiet:
            print(f'OK: registry written to {path}')
            print(f'   {valid} valid businesses indexed, {invalid} invalid')
            for slug, entry in sorted(registry['businesses'].items()):
                print(f'   - {slug} v{entry["version"]} (protocol {entry["protocol"]}, '
                      f'employees {entry["employee_count"]}, mode {entry["operation_mode"]})')
            for inv in registry.get('_invalid_entries', []):
                print(f'   ! INVALID: {inv["slug"]} ({inv["path"]}): {inv["error"][:120]}')
        return 0

    if args.cmd == 'scan':
        items = scan_roots(args.roots)
        for it in items:
            print(json.dumps(it, ensure_ascii=False))
        return 0

    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
