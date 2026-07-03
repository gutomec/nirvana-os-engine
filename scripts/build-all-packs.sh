#!/usr/bin/env bash
# Assembla + builda + gateia todos os packs nichados restantes. Saída local em dist/.
# NÃO faz deploy; só prepara os artefatos + reporta a composição p/ o product.ts.
set -uo pipefail
BUN=/Users/guto/.bun/bin/bun
NODE=/opt/homebrew/bin/node
SQ=~/squads; BZ=~/businesses; LIB=~/businesses/_library/dna
NOS=~/nirvana-os
VALIDATE=~/.nirvana/skills/squads/scripts/validate-squad.ts
STRIP=~/squads-sh-v2/scripts/strip-base-watermarks.mjs

build_pack() {
  local slug="$1" name="$2" tagline="$3" biz="$4" squads="$5"
  local CD="$NOS/packs-content/$slug"
  rm -rf "$CD"; mkdir -p "$CD/squads" "$CD/businesses" "$CD/mind-clones"
  local nsq=0 nbz=0 ncl=0 missing=""
  for s in $squads; do
    if [ -d "$SQ/$s" ]; then cp -R "$SQ/$s" "$CD/squads/"; nsq=$((nsq+1)); else missing="$missing sq:$s"; fi
  done
  for b in $biz; do
    if [ -d "$BZ/$b" ]; then cp -R "$BZ/$b" "$CD/businesses/"; nbz=$((nbz+1)); else missing="$missing bz:$b"; fi
  done
  # clones referenciados pelas empresas (self-sufficiency)
  local refd=""
  for b in $biz; do
    [ -d "$BZ/$b/employees" ] || continue
    for c in $(ls "$LIB" 2>/dev/null); do
      grep -rqiw "$c" "$BZ/$b/employees" 2>/dev/null && refd="$refd $c"
    done
  done
  for c in $(echo "$refd" | tr ' ' '\n' | sort -u | grep -v '^$'); do
    [ -d "$LIB/$c" ] && cp -R "$LIB/$c" "$CD/mind-clones/" && ncl=$((ncl+1))
  done
  # limpar pollution
  find "$CD" -type d \( -name node_modules -o -name .git -o -name outputs -o -name .omc \) -exec rm -rf {} + 2>/dev/null
  find "$CD" -name 'bun.lock' -o -name 'package.json' -path '*/tasks/*' 2>/dev/null | xargs rm -f 2>/dev/null
  # README — bespoke, localized (EN + 5 locales) from packs-content/_readmes/<slug>/.
  # The heredoc template is retired; each pack ships hand-authored sales READMEs.
  local RDIR="$NOS/packs-content/_readmes/$slug"
  if compgen -G "$RDIR/README*.md" >/dev/null 2>&1; then
    cp "$RDIR"/README*.md "$CD/"
  else
    echo "  WARN: no bespoke README at $RDIR — pack will ship without one" >&2
  fi
  # build + zip
  ( cd "$NOS" && $BUN scripts/build-content-pack.ts "$slug" "packs-content/$slug" >/dev/null 2>&1 )
  local PK="$NOS/dist/$slug-pack"
  rm -f "/tmp/$slug.zip"; ( cd "$PK" && zip -rqX "/tmp/$slug.zip" . -x '*.DS_Store' )
  # gate
  local pass=0 tot=0
  for d in "$PK"/starter-pack/squads/*/; do tot=$((tot+1)); r=$($BUN "$VALIDATE" "$d" 2>&1 | grep -c '\[PASS\]'); [ "$r" = "1" ] && pass=$((pass+1)); done
  local wm=$($NODE "$STRIP" "$PK" --check 2>&1 | grep -oE '[0-9]+ watermark markers' | grep -oE '^[0-9]+')
  local leak="none"; { [ -d "$PK/skills" ] || [ -d "$PK/bin" ]; } && leak="LEAK"
  local mb=$(( $(stat -f%z "/tmp/$slug.zip")/1024/1024 ))
  echo "SPEC|$slug|squads=$nsq|biz=$nbz|clones=$ncl|gate=$pass/$tot|wm=${wm:-?}|leak=$leak|${mb}MB|missing:$missing"
}

echo "=== assemblando + buildando todos os packs ==="
build_pack creative-studio "Nirvana — Creative Studio" "Vídeo, imagem, áudio e produção episódica — do roteiro ao asset final." \
  "cinema-machine vivid-pancake serial-showrunner-nirvana voicecraft" \
  "higgsfield-studio-nirvana veo-motion-studio image2-virtuoso infographic-virtuoso vivid-pancake-keyframe-i2v nirvana-video-creator brandcraft voice-seed-architect tts-brief-analysis audio-chunking multi-provider-prompt-build audio-render-cloud audio-postprod"
build_pack web-design "Nirvana — Web, Design & Landing" "Sites nível Awwwards, design systems e landing pages de alta conversão." \
  "design-singularity ux-atelier" \
  "awwwards-singularity-studio design-system-nirvana ultimate-landingpage landing-page-nirvana nirvana-landingpage enterprise-dashboard-nirvana nirvana-design-grafico image2-virtuoso infographic-virtuoso brandcraft"
build_pack engineering-devops "Nirvana — Engineering & DevOps" "Um time de engenharia sênior autônomo: backend, API, DevOps, segurança e dados." \
  "software-forge systems-atelier" \
  "nirvana-backend postgres-architect-nirvana api-development code-review automated-code-review-squad devops-pipeline monitoring testing documentation oracle-supreme-squad cli-universal-squad nirvana-security-fullstack security-audit archon-architect-nirvana nirvana-autopilot genesis-planning-nirvana nirvana-saas-startup nirvana-context-engineering nirvana-context-window-optimizer nirvana-readme-architect data-pipeline ml-pipeline data-quality-guardian nirvana-visualizer-squad"
build_pack fintech-crypto "Nirvana — Fintech, Crypto & Trading" "Incubadora fintech regulada, tokens Solana, trading e assessoria de investimentos." \
  "fintech-forge crypto-foundry trading-nexus" \
  "crypto-token-forge nirvana-crypto-trading nirvana-ai-trading nirvana-assessoria-investimentos nirvana-compliance-lgpd nirvana-juridico-total nirvana-backend nirvana-security-fullstack"
build_pack research-intelligence "Nirvana — Research & Intelligence" "Forecasting, investigação/OSINT, consultoria de mesa-redonda e pesquisa de mercado." \
  "research-intelligence investigation-bureau strategic-council nexus-council market-intelligence strategy-consulting" \
  "sherlock-holmes-nirvana roundtable-debate-nirvana nirvana-pesquisa-mercado opportunity-hunter-squad nirvana-ideation oracle-supreme-squad competitor-radar-squad"
build_pack publishing-knowledge "Nirvana — Publishing & Knowledge" "Escreve, ilustra, formata e lança livros; converte e organiza conhecimento." \
  "ars-libri polymath-press" \
  "ebook-maestro-nirvana amazon-book-writer nirvana-editora omnidoc-vision-nirvana notebooklm-automation nirvana-wiki-brain documentation high-conversion-copy"
build_pack health-management "Nirvana — Gestão de Saúde" "Operação completa de clínicas e consultórios BR (prontuário, TISS, compliance)." \
  "holding-saude-ai" \
  "nirvana-clinica-medica nirvana-fisioterapia nirvana-odontologia nirvana-veterinaria nirvana-psicologo nirvana-nutricao nirvana-laboratorio nirvana-farmacia ambient-clinical-scribe"
build_pack food-hospitality "Nirvana — Food, Hotelaria & Serviços Locais" "Restaurantes, hotéis, eventos, turismo, petshop, salão e coworking." \
  "foodtech-collective" \
  "nirvana-restaurante nirvana-hotelaria nirvana-eventos nirvana-turismo nirvana-petshop nirvana-salao-beleza nirvana-coworking"
build_pack realestate-construction "Nirvana — Imobiliário, Construção & Energia" "Imobiliárias, arquitetura, engenharia civil, condomínios e energia solar." \
  "real-estate-nexus energy-infinity" \
  "nirvana-imobiliaria nirvana-arquitetura nirvana-engenharia-civil nirvana-condominios nirvana-energia-solar"
build_pack education "Nirvana — Educação & Cursos" "Escolas, pós-graduação, cursos online e tutoria adaptativa." \
  "edtech-empire" \
  "nirvana-escola-particular nirvana-pos-graduacao nirvana-curso-online adaptive-tutor-k12"
build_pack commerce-backoffice "Nirvana — Comércio, Logística & Back-office" "E-commerce, logística, comex, contábil, fiscal, RH e recrutamento." \
  "" \
  "nirvana-ecommerce nirvana-logistica nirvana-comex nirvana-concessionaria nirvana-franquia nirvana-contabilidade nirvana-rh-dp nirvana-recrutamento nirvana-consultoria-empresarial"
build_pack creators "Nirvana — Creators & Personal Brands" "Músicos, coaches, personal trainers e estúdios de jogos indie." \
  "game-studio-nirvana" \
  "nirvana-musico nirvana-coach-mentor nirvana-personal-trainer nirvana-game-studio"
build_pack legal-compliance "Nirvana — Legal & Compliance Suite" "Advocacia, compliance e SST agênticos para o Brasil." \
  "juridical-singularity compliance-citadel medwork360" \
  "nirvana-juridico-total nirvana-juridico judicial-search-brasil nirvana-compliance-lgpd contract-review-squad nirvana-seguranca-trabalho iso-42001-aims-implementation process-analysis comply-check-squad"
build_pack marketing-growth "Nirvana — Marketing & Growth Studio" "O stack de marketing completo." \
  "ads-intelligence performance-growth-lab content-social-factory alientech-360 niche-radar-studio-nirvana crm-lifecycle launch-lab-br creator-economy-division agency-hq" \
  "brandcraft sales-funnel-masters high-conversion-copy instagram-intelligence-nirvana content-multiplier-squad content-factory-squad copy-infoprodutos opportunity-hunter-squad competitor-radar-squad nirvana-agencia-marketing nirvana-pesquisa-mercado image2-virtuoso infographic-virtuoso higgsfield-studio-nirvana landing-page-nirvana"
echo "=== fim ==="
