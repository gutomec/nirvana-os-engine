"""
Nirvana Configurable Limits — cascade loader (Python)

Exact mirror of limits.ts.

Loads size/count limits with a precedence cascade:

  1. NIRVANA_LIMIT_<KEY> env vars        (highest precedence)
  2. <cwd or ancestor>/.nirvana-limits.yaml   (project override)
  3. ~/.claude/nirvana-limits.yaml        (user override)
  4. DEFAULTS                              (the system's historical values)

Backward-compatible: with no .yaml and no env vars, the DEFAULTS are
identical to the original hard-coded limits, so behavior is unchanged.

Every setting goes through SAFETY_BOUNDS: absurd values (that would
break existing entities or create operational risk) are clamped to the
safe floor/ceiling, with a warning on stderr.

Debug: export NIRVANA_LIMITS_DEBUG=1 to see each limit and its source.

Design philosophy (see _shared/CONFIGURATION.md, configurable limits):
- PAYLOAD SIZE (description, examples, keywords) → configurable, low risk.
- EXECUTION CONTROL (turns, tokens, handoffs) → configurable WITH a safety
  ceiling, because raising it without a budget cap is a real financial risk.
- FEATURE LIMITS (handoff.blockers=3, orgchart.reports=1, domains) → NOT
  exposed: the limit is a design feature, not a bug.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Optional


# ──────────────────────────────────────────────────────────────────────
# DEFAULTS — the system's historical values (backward-compatible)
# ──────────────────────────────────────────────────────────────────────

DEFAULTS: dict[str, Any] = {
    # ── business.yaml — PAYLOAD SIZE (Bucket A) ──
    # Defaults sized for real multi-dimension companies (the council manifest
    # alone is ~1245 chars + 43 keywords). All within SAFETY_BOUNDS; override
    # via ~/.claude/nirvana-limits.yaml if you need more.
    "business_description_max": 2000,
    "business_produces_max": 60,
    "business_example_briefs_max": 30,
    "business_example_briefs_item_max": 1000,
    "business_keywords_max": 100,
    "business_capabilities_max": 100,
    # Business Protocol 2.0 §6.9: routing fences.
    "business_not_for_max": 40,

    # ── employee frontmatter ──
    # None = no ceiling (historical behavior). May be given an integer.
    "employee_description_max": None,
    "employee_max_turns_max": 1000,

    # ── capability (squad.yaml) — PAYLOAD SIZE ──
    "capability_description_max": 1500,
    "capability_produces_max": 40,
    "capability_example_briefs_max": 20,
    "capability_example_briefs_item_max": 1000,
    "capability_keywords_max": 60,

    # ── squad.yaml ──
    "squad_capabilities_max": 50,

    # ── workflow document (Squad Protocol v6) — PAYLOAD SIZE ──
    # Prose body of a Markdown workflow, in words: a ceiling, never a
    # rejection (the lint warns under any protocol). 2500 words is ~6x the
    # largest body the library has today.
    "workflow_body_words_max": 2500,
    # Byte target for the agent + task documents the squad prompt carries.
    # Every referenced document travels whole anyway; this is a soft ceiling
    # flagged in a note when crossed, never a cut (squad-exec.ts).
    "squad_prompt_components_bytes_max": 65536,

    # ── mind-clone DNA frontmatter ──
    "dna_max_turns_max": 1000,

    # ── handoff artifact — PAYLOAD SIZE ──
    "handoff_summary_max": 3000,
    "handoff_files_modified_max": 30,

    # ── business memory GC ──
    "business_memory_max_facts_ceiling": 5000,

    # ── harness budget — EXECUTION CONTROL (Bucket B — MAX POWER v2) ──
    # Nirvana stays out of the way. Default $1M / 10M tokens / 24h.
    "harness_default_max_tokens": 10_000_000,
    "harness_default_max_cost_usd": 1_000_000.00,
    "harness_default_max_handoffs": 1_000,
    "harness_default_max_duration_seconds": 86_400,
}


# ──────────────────────────────────────────────────────────────────────
# SAFETY_BOUNDS — (floor, ceiling) for each configurable limit.
# None in either position = no restriction in that direction.
# Protects against values that would break existing entities (floor) or
# create operational/financial risk (ceiling).
# ──────────────────────────────────────────────────────────────────────

SAFETY_BOUNDS: dict[str, tuple[Optional[float], Optional[float]]] = {
    # Floor 200: existing mind-clone/business descriptions already exceed
    # 200 chars; going lower would break entities. Ceiling 5000: above
    # that the discovery BM25 ranking degrades (the description becomes noise).
    "business_description_max": (200, 5000),
    "business_produces_max": (10, 200),
    "business_example_briefs_max": (5, 60),
    "business_example_briefs_item_max": (200, 2000),
    "business_keywords_max": (15, 300),
    "business_capabilities_max": (20, 500),
    "business_not_for_max": (5, 200),

    "employee_description_max": (200, 8000),  # if set (None is ignored)
    "employee_max_turns_max": (50, 1000),     # >1000 risks a runaway

    "capability_description_max": (200, 5000),
    "capability_produces_max": (8, 120),
    "capability_example_briefs_max": (4, 40),
    "capability_example_briefs_item_max": (200, 2000),
    "capability_keywords_max": (10, 200),

    "squad_capabilities_max": (10, 200),

    "workflow_body_words_max": (200, 20_000),
    "squad_prompt_components_bytes_max": (8_192, 1_048_576),

    "dna_max_turns_max": (40, 1000),

    "handoff_summary_max": (500, 8000),
    "handoff_files_modified_max": (5, 100),

    "business_memory_max_facts_ceiling": (500, 50_000),

    # Execution control — MAX POWER v2 (after NIRVANA-OS-CORRECTION-REPORT).
    # The default is now $1M / 10M tokens / 24h / 1000 handoffs. Whoever wants
    # to tighten it configures the project. Loose ceiling: 100x the default.
    "harness_default_max_tokens": (50_000, 100_000_000),
    "harness_default_max_cost_usd": (0.10, 100_000_000.00),
    "harness_default_max_handoffs": (10, 100_000),
    "harness_default_max_duration_seconds": (120, 604_800),  # 7 dias
}


_USER_CONFIG = Path.home() / ".claude" / "nirvana-limits.yaml"
_PROJECT_CONFIG_NAME = ".nirvana-limits.yaml"
_ENV_PREFIX = "NIRVANA_LIMIT_"

# Opt out of the whole cascade and answer with DEFAULTS. A process that writes a
# DISTRIBUTABLE artifact sets this: the cascade is a local operator affordance,
# and a file every consumer reads may only embed numbers that are committed.
# Mirror of DEFAULTS_ONLY_ENV in limits.ts.
DEFAULTS_ONLY_ENV = "NIRVANA_LIMITS_DEFAULTS_ONLY"


def _defaults_only() -> bool:
    value = os.environ.get(DEFAULTS_ONLY_ENV)
    if value is None:
        return False
    return value.strip().lower() not in ("", "0", "false", "no", "off")


def _log(msg: str) -> None:
    print(f"[nirvana-limits] {msg}", file=sys.stderr)


def _parse_flat_yaml(text: str) -> dict[str, Any]:
    """Flat YAML parser (only key: value pairs, no nesting).

    The nirvana-limits.yaml file is deliberately flat. We do not use
    PyYAML here, to keep exact parity with limits.ts (which has no
    YAML dependency). Supports: '#' comments, blank lines,
    int/float/null/string values.
    """
    out: dict[str, Any] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        # strip the inline comment (after ' #')
        if " #" in value:
            value = value.split(" #", 1)[0].strip()
        if not key:
            continue
        out[key] = _coerce_scalar(value)
    return out


def _coerce_scalar(value: str) -> Any:
    """Convert a config string to int/float/None/bool/str."""
    if value == "" or value.lower() in ("null", "~", "none"):
        return None
    if value.lower() in ("true", "yes", "on"):
        return True
    if value.lower() in ("false", "no", "off"):
        return False
    # strip thousands separators (1_000 or 1,000), for numerics only
    numeric = value.replace("_", "")
    try:
        if "." in numeric:
            return float(numeric)
        return int(numeric)
    except ValueError:
        return value.strip("\"'")


def _coerce_to_default_type(value: Any, default: Any) -> Any:
    """Ensure the configured value has the default's type."""
    if default is None:
        # default None = the field accepts int or None
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    if isinstance(default, bool):
        return bool(value)
    if isinstance(default, int):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default
    if isinstance(default, float):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default
    return value


def _load_config_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return _parse_flat_yaml(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 — an invalid config must not break validation
        _log(f"WARN: failed to read {path}: {exc}; ignoring")
        return {}


def _find_project_config() -> Optional[Path]:
    """Look for .nirvana-limits.yaml from the cwd up to the root."""
    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        candidate = parent / _PROJECT_CONFIG_NAME
        if candidate.is_file():
            return candidate
    return None


def _apply_safety_bounds(key: str, value: Any) -> Any:
    """Clamp a value to the safe floor/ceiling. Warns when it clamps."""
    if value is None:
        return None
    bounds = SAFETY_BOUNDS.get(key)
    if bounds is None:
        return value
    lo, hi = bounds
    if lo is not None and value < lo:
        _log(f"WARN: {key}={value} below the safe floor {lo}; clamped to {lo}")
        return lo
    if hi is not None and value > hi:
        _log(f"WARN: {key}={value} above the safe ceiling {hi}; clamped to {hi}")
        return hi
    return value


def load_limits() -> dict[str, Any]:
    """Load the limits with a user → project → env cascade + safety bounds.

    NIRVANA_LIMITS_DEFAULTS_ONLY=1 skips the three layers and answers DEFAULTS.
    """
    limits: dict[str, Any] = dict(DEFAULTS)
    sources: dict[str, str] = {k: "default" for k in limits}

    # A distributable artifact reads DEFAULTS and nothing else. The safety
    # bounds below still run: the DEFAULTS fit inside them by construction,
    # and a single exit keeps the two modes from diverging.
    pinned = _defaults_only()

    # 1. User-level (~/.claude/nirvana-limits.yaml)
    user_cfg = {} if pinned else _load_config_file(_USER_CONFIG)
    for k, v in user_cfg.items():
        if k in limits:
            limits[k] = _coerce_to_default_type(v, DEFAULTS[k])
            sources[k] = f"user:{_USER_CONFIG}"
        else:
            _log(f"WARN: unknown key ignored in {_USER_CONFIG}: {k!r}")

    # 2. Project-level (.nirvana-limits.yaml — sobrescreve user)
    project_path = None if pinned else _find_project_config()
    if project_path is not None:
        project_cfg = _load_config_file(project_path)
        for k, v in project_cfg.items():
            if k in limits:
                limits[k] = _coerce_to_default_type(v, DEFAULTS[k])
                sources[k] = f"project:{project_path}"
            else:
                _log(f"WARN: unknown key ignored in {project_path}: {k!r}")

    # 3. Env vars (NIRVANA_LIMIT_* — highest precedence)
    for k in limits:
        env_key = _ENV_PREFIX + k.upper()
        if not pinned and env_key in os.environ:
            limits[k] = _coerce_to_default_type(
                _coerce_scalar(os.environ[env_key]), DEFAULTS[k]
            )
            sources[k] = f"env:{env_key}"

    # 4. Safety bounds — clamp absurd values
    for k in list(limits.keys()):
        limits[k] = _apply_safety_bounds(k, limits[k])

    if os.getenv("NIRVANA_LIMITS_DEBUG"):
        _log("limites efetivos:")
        for k in sorted(limits):
            _log(f"  {k} = {limits[k]}  (fonte: {sources[k]})")

    limits["_sources"] = sources  # type: ignore[assignment]
    return limits


# Singleton — loaded once when the module is imported.
LIMITS: dict[str, Any] = load_limits()


if __name__ == "__main__":
    # `python limits.py` → prints the table of effective limits.
    print("Nirvana Configurable Limits — effective values\n")
    src = LIMITS.get("_sources", {})
    for key in sorted(DEFAULTS):
        eff = LIMITS[key]
        dft = DEFAULTS[key]
        marker = "" if eff == dft else "  ← override"
        print(f"  {key:42s} = {str(eff):>12s}  (default {dft}){marker}  [{src.get(key, 'default')}]")
