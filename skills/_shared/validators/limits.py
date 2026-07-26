"""
Nirvana Configurable Limits — cascade loader (Python)

Mirror exato de limits.ts.

Carrega limites de tamanho/contagem com cascata de precedência:

  1. NIRVANA_LIMIT_<KEY> env vars        (precedência máxima)
  2. <cwd ou ancestral>/.nirvana-limits.yaml   (override do projeto)
  3. ~/.claude/nirvana-limits.yaml        (override do usuário)
  4. DEFAULTS                              (valores históricos do sistema)

Backward-compatible: sem nenhum .yaml e sem env vars, os DEFAULTS são
idênticos aos limites originais hard-coded — comportamento inalterado.

Toda configuração passa por SAFETY_BOUNDS: valores absurdos (que
quebrariam entidades já existentes ou criariam risco operacional) são
clampados ao piso/teto seguro, com aviso no stderr.

Debug: exporte NIRVANA_LIMITS_DEBUG=1 para ver cada limite + sua fonte.

Filosofia de design (ver _shared/CONFIGURATION.md §Limites configuráveis):
- PAYLOAD SIZE (description, examples, keywords) → configurável, baixo risco.
- EXECUTION CONTROL (turns, tokens, handoffs) → configurável COM teto de
  segurança, pois aumentar sem cap orçamentário é risco financeiro real.
- FEATURE LIMITS (handoff.blockers=3, orgchart.reports=1, domains) → NÃO
  expostos: o limite é uma feature de design, não um bug.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Optional


# ──────────────────────────────────────────────────────────────────────
# DEFAULTS — valores históricos do sistema (backward-compatible)
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

    # ── employee frontmatter ──
    # None = sem teto (comportamento histórico). Pode receber um inteiro.
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

    # ── mind-clone DNA frontmatter ──
    "dna_max_turns_max": 1000,

    # ── handoff artifact — PAYLOAD SIZE ──
    "handoff_summary_max": 3000,
    "handoff_files_modified_max": 30,

    # ── business memory GC ──
    "business_memory_max_facts_ceiling": 5000,

    # ── harness budget — EXECUTION CONTROL (Bucket B — MAX POWER v2) ──
    # Nirvana fica fora do caminho. Default $1M / 10M tokens / 24h.
    "harness_default_max_tokens": 10_000_000,
    "harness_default_max_cost_usd": 1_000_000.00,
    "harness_default_max_handoffs": 1_000,
    "harness_default_max_duration_seconds": 86_400,
}


# ──────────────────────────────────────────────────────────────────────
# SAFETY_BOUNDS — (piso, teto) para cada limite configurável.
# None em qualquer posição = sem restrição naquela direção.
# Protege contra valores que quebrariam entidades existentes (piso) ou
# criariam risco operacional/financeiro (teto).
# ──────────────────────────────────────────────────────────────────────

SAFETY_BOUNDS: dict[str, tuple[Optional[float], Optional[float]]] = {
    # Piso 200 — descrições de mind-clones/businesses existentes já passam
    # de 200 chars; baixar disso quebraria entidades. Teto 5000 — acima
    # disso o ranking BM25 do discovery degrada (descrição vira ruído).
    "business_description_max": (200, 5000),
    "business_produces_max": (10, 200),
    "business_example_briefs_max": (5, 60),
    "business_example_briefs_item_max": (200, 2000),
    "business_keywords_max": (15, 300),
    "business_capabilities_max": (20, 500),

    "employee_description_max": (200, 8000),  # se definido (None ignora)
    "employee_max_turns_max": (50, 1000),     # >1000 é risco de runaway

    "capability_description_max": (200, 5000),
    "capability_produces_max": (8, 120),
    "capability_example_briefs_max": (4, 40),
    "capability_example_briefs_item_max": (200, 2000),
    "capability_keywords_max": (10, 200),

    "squad_capabilities_max": (10, 200),

    "dna_max_turns_max": (40, 1000),

    "handoff_summary_max": (500, 8000),
    "handoff_files_modified_max": (5, 100),

    "business_memory_max_facts_ceiling": (500, 50_000),

    # Execution control — MAX POWER v2 (pós NIRVANA-OS-CORRECTION-REPORT).
    # Default agora é $1M / 10M tokens / 24h / 1000 handoffs. Quem quiser
    # apertar configura no projeto. Teto solto: 100x do default.
    "harness_default_max_tokens": (50_000, 100_000_000),
    "harness_default_max_cost_usd": (0.10, 100_000_000.00),
    "harness_default_max_handoffs": (10, 100_000),
    "harness_default_max_duration_seconds": (120, 604_800),  # 7 dias
}


_USER_CONFIG = Path.home() / ".claude" / "nirvana-limits.yaml"
_PROJECT_CONFIG_NAME = ".nirvana-limits.yaml"
_ENV_PREFIX = "NIRVANA_LIMIT_"


def _log(msg: str) -> None:
    print(f"[nirvana-limits] {msg}", file=sys.stderr)


def _parse_flat_yaml(text: str) -> dict[str, Any]:
    """Parser de YAML achatado (apenas pares key: value, sem aninhamento).

    O arquivo nirvana-limits.yaml é deliberadamente flat. Não usamos
    PyYAML aqui para manter paridade exata com limits.ts (que não tem
    dependência de YAML). Suporta: comentários '#', linhas em branco,
    valores int/float/null/string.
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
        # remove comentário inline (após ' #')
        if " #" in value:
            value = value.split(" #", 1)[0].strip()
        if not key:
            continue
        out[key] = _coerce_scalar(value)
    return out


def _coerce_scalar(value: str) -> Any:
    """Converte string de config para int/float/None/bool/str."""
    if value == "" or value.lower() in ("null", "~", "none"):
        return None
    if value.lower() in ("true", "yes", "on"):
        return True
    if value.lower() in ("false", "no", "off"):
        return False
    # remove separadores de milhar (1_000 ou 1,000) só para numéricos
    numeric = value.replace("_", "")
    try:
        if "." in numeric:
            return float(numeric)
        return int(numeric)
    except ValueError:
        return value.strip("\"'")


def _coerce_to_default_type(value: Any, default: Any) -> Any:
    """Garante que o valor configurado tem o tipo do default."""
    if default is None:
        # default None = campo aceita int ou None
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
    except Exception as exc:  # noqa: BLE001 — config inválida não pode derrubar validação
        _log(f"WARN: falha ao ler {path}: {exc} — ignorando")
        return {}


def _find_project_config() -> Optional[Path]:
    """Procura .nirvana-limits.yaml a partir do cwd subindo até a raiz."""
    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        candidate = parent / _PROJECT_CONFIG_NAME
        if candidate.is_file():
            return candidate
    return None


def _apply_safety_bounds(key: str, value: Any) -> Any:
    """Clampa valor ao piso/teto seguro. Emite aviso se clampar."""
    if value is None:
        return None
    bounds = SAFETY_BOUNDS.get(key)
    if bounds is None:
        return value
    lo, hi = bounds
    if lo is not None and value < lo:
        _log(f"WARN: {key}={value} abaixo do piso seguro {lo} — clampado para {lo}")
        return lo
    if hi is not None and value > hi:
        _log(f"WARN: {key}={value} acima do teto seguro {hi} — clampado para {hi}")
        return hi
    return value


def load_limits() -> dict[str, Any]:
    """Carrega os limites com cascata user → project → env + safety bounds."""
    limits: dict[str, Any] = dict(DEFAULTS)
    sources: dict[str, str] = {k: "default" for k in limits}

    # 1. User-level (~/.claude/nirvana-limits.yaml)
    user_cfg = _load_config_file(_USER_CONFIG)
    for k, v in user_cfg.items():
        if k in limits:
            limits[k] = _coerce_to_default_type(v, DEFAULTS[k])
            sources[k] = f"user:{_USER_CONFIG}"
        else:
            _log(f"WARN: chave desconhecida ignorada em {_USER_CONFIG}: {k!r}")

    # 2. Project-level (.nirvana-limits.yaml — sobrescreve user)
    project_path = _find_project_config()
    if project_path is not None:
        project_cfg = _load_config_file(project_path)
        for k, v in project_cfg.items():
            if k in limits:
                limits[k] = _coerce_to_default_type(v, DEFAULTS[k])
                sources[k] = f"project:{project_path}"
            else:
                _log(f"WARN: chave desconhecida ignorada em {project_path}: {k!r}")

    # 3. Env vars (NIRVANA_LIMIT_* — precedência máxima)
    for k in limits:
        env_key = _ENV_PREFIX + k.upper()
        if env_key in os.environ:
            limits[k] = _coerce_to_default_type(
                _coerce_scalar(os.environ[env_key]), DEFAULTS[k]
            )
            sources[k] = f"env:{env_key}"

    # 4. Safety bounds — clampa valores absurdos
    for k in list(limits.keys()):
        limits[k] = _apply_safety_bounds(k, limits[k])

    if os.getenv("NIRVANA_LIMITS_DEBUG"):
        _log("limites efetivos:")
        for k in sorted(limits):
            _log(f"  {k} = {limits[k]}  (fonte: {sources[k]})")

    limits["_sources"] = sources  # type: ignore[assignment]
    return limits


# Singleton — carregado uma vez na importação do módulo.
LIMITS: dict[str, Any] = load_limits()


if __name__ == "__main__":
    # `python limits.py` → imprime tabela de limites efetivos.
    print("Nirvana Configurable Limits — valores efetivos\n")
    src = LIMITS.get("_sources", {})
    for key in sorted(DEFAULTS):
        eff = LIMITS[key]
        dft = DEFAULTS[key]
        marker = "" if eff == dft else "  ← override"
        print(f"  {key:42s} = {str(eff):>12s}  (default {dft}){marker}  [{src.get(key, 'default')}]")
