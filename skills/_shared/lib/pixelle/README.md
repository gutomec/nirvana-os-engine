# Pixelle-Video Integration — shared library

Cross-squad integration of [Pixelle-Video](https://aidc-ai.github.io/Pixelle-Video/) for any squad that produces video. Single source of truth so all 21+ video-capable squads dispatch through the same API, configuration, and voice-clone pipeline.

## Why this exists

Each squad that produces video (reels, podcast clips, real-estate walkthroughs, course lessons, ads creatives, etc.) shouldn't reimplement Pixelle dispatch, default voices, fallback config, or voice-clone reference handling. This module provides:

1. `client.js` — typed JS client around Pixelle's REST API (`/api/video/generate/{sync|async}`, polling).
2. `defaults.yaml` — sane defaults (frame templates, BGM volume, TTS workflow, video resolution per platform).
3. `voice-clone-pipeline.md` — canonical user flow for "user uploads voice reference → squad uses it for narration".
4. `setup-wizard.md` — agentic onboarding the squads invoke when the user hasn't configured Pixelle yet.
5. `tts-models-2026.yaml` — ranked catalog of voice-clone models (Chatterbox, F5-TTS-pt-br, IndexTTS-2, XTTS, Fish Speech, OpenVoice, ElevenLabs, Edge-TTS) with PT-BR / EN suitability scores.

## Files

- `client.js` — programmatic client (sync/async/poll/upload)
- `defaults.yaml` — defaults per platform (instagram-reel, tiktok, youtube-shorts, podcast, real-estate-tour, course-lesson)
- `tts-models-2026.yaml` — model catalog ranked by language + quality + license
- `voice-clone-pipeline.md` — flow for capturing user voice
- `setup-wizard.md` — guided config when user hasn't set up Pixelle
- `troubleshooting.md` — common errors + fixes (referencing `(base de conhecimento interna)` section 13)

## Knowledge source

The full Pixelle research (architecture, install, API, costs, alternatives) is in `(base de conhecimento interna)`. Squads that need to deeply understand Pixelle should `Read` that file. This shared library is the **operational** layer; the research file is the **reference** layer.

## Used by

Auto-discovered by any squad that declares the capability `media.pixelle_video.compose`. Currently:

- brandcraft / brandcraft-nirvana
- content-multiplier-squad
- instagram-intelligence-nirvana
- nirvana-agencia-marketing
- nirvana-coach-mentor
- nirvana-concessionaria, nirvana-hotelaria, nirvana-imobiliaria, nirvana-restaurante, nirvana-salao-beleza (verticals com social media)
- nirvana-curso-online (course lessons)
- nirvana-musico
- nirvana-personal-trainer
- nirvana-podcast
- nirvana-produtora-video
- nirvana-realestate-videomaker
- nirvana-video-creator
- notebooklm-automation (audio-to-video)
- proposal-forge-squad (video proposals)
- support-hub-squad (video tutorials)
