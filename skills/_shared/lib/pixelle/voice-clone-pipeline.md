# Voice Clone Pipeline — canonical user flow

## When to use

Any squad about to dispatch a Pixelle video that benefits from the user's own voice (or a chosen talent's voice) instead of a generic TTS preset:

- Personal brand reels, podcast clips, course lessons, sales videos, product demos.
- Any deliverable where "sounding like the user" is part of the value.

## Decision tree

```
Squad is producing video → user wants voice cloning?
├── User says "use my voice" / "clone my voice" / "use the voice of X"
│   ├── Check: ${voices_dir} já tem amostra recente? (listVoiceReferences)
│   │   ├── SIM → confirmar com user: "Uso o áudio '<name>'?" → segue
│   │   └── NÃO → entrar no flow de captura abaixo
│   └── ...
└── Não → tts_workflow = edge-tts (Edge-TTS PT-BR Francisca / Antonio); pular este flow
```

## Capture flow (squad-driven, conversational)

When the user wants their voice but no reference audio is on file, the squad MUST guide the user through one of these three paths. Squad dispatches `Agent({subagent_type: "general-purpose", prompt: <persona + voice-clone instructions>})` to drive the conversation. Squad does NOT proceed to video generation until `validateRefAudio` returns `ok: true`.

### Path A — Direct upload (recommended)

Best path. User records once and reuses across all squads.

1. **Ask the user to record 30–60s of clean speech** in their natural voice. Script suggestion:
   > "Olá, meu nome é [nome]. Hoje vou contar uma rápida história sobre algo que aprendi essa semana. [continuar 30-60s contando algo natural]. Esse áudio será usado como referência para clonar minha voz nos próximos vídeos."
2. Recording recommendations:
   - Quiet room, no echo, no background music.
   - Phone (recent iPhone/Android) is enough; built-in voice memo at default quality is fine.
   - Speak naturally, don't read robotically.
   - Keep tone consistent with how you want videos to sound.
3. **User saves the file** as MP3, WAV, or FLAC.
4. **User provides the path** (drag-and-drop in Claude Code; or save to `~/Downloads/voice.wav`).
5. Squad runs:
   ```bash
   node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js validate-audio /path/to/voice.wav
   # then if ok:
   node ${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js save-voice /path/to/voice.wav <user-or-talent-name>
   ```
6. Squad confirms: "Voz salva em `~/.pixelle-voices/<slug>.wav`. Pronto pra usar em todos os squads de vídeo."

### Path B — ElevenLabs export

User already paid for ElevenLabs and has a clone there.

1. Ask: "Você já tem uma voz clonada no ElevenLabs?"
2. If yes: instruct user to generate a 30s sample on ElevenLabs (Voice Library → seu clone → "Generate Sample" com qualquer texto natural).
3. User downloads the MP3.
4. Same `validate-audio` + `save-voice` flow as Path A.
5. Note in metadata: `source: elevenlabs_export` (so squads know the timbre comes from ElevenLabs).

### Path C — Live record via browser (only when user is in a setup that supports it)

If the user is using Claude with a browser-capable interface:

1. Squad emits link to a recorder utility (or instructs user to use Voice Memo / Audacity).
2. User records, exports.
3. Same `validate-audio` + `save-voice` flow.

## Validation rules (enforced by client.js)

Before accepting any audio:
- File exists.
- Extension is `.mp3`, `.wav`, `.flac`, `.m4a`, or `.ogg`.
- Size between 50 KB (≈3s of low-bitrate) and 50 MB.

If validation fails, squad asks user to re-record and explains why. Common rejections:
- File not found → check the path.
- Too small → need ≥5–10s of audio.
- Too large → 50MB cap; export at lower bitrate.
- Wrong format → most voice memo apps export `.m4a`; that's fine.

## Quality tips the squad SHOULD share with the user

- **30–60s is the sweet spot.** Shorter = lower-quality clone. Longer = diminishing returns.
- **Single speaker.** Clone breaks if there's a second person in the audio.
- **No music or background noise.** Strip BGM in Audacity if needed.
- **Natural speech.** Don't read with excessive cadence — the clone learns your prosody.
- **Stable distance from mic.** No fluctuating levels.
- **Same recording conditions as future use.** If you'll generate videos meant to sound conversational, record conversationally.

## Picking the model

`tts-models-2026.yaml` has the canonical selection rules. Summary:

| User said | Audio length | Language | Pick |
|---|---|---|---|
| "use my voice" (PT-BR speaker) | ≥30s | PT-BR | `f5-tts-pt-br` |
| "clone the voice in this audio" (mixed) | ≥10s | PT-BR or EN | `chatterbox-multilingual` |
| "clone for video dubbing, must hit timing" | ≥10s | any | `index-tts-2` |
| "I have ElevenLabs already" | n/a (use exported audio as ref) | any | `chatterbox-multilingual` |
| "no audio, just generate" | n/a | PT-BR | `edge-tts` (Francisca/Antonio) |
| "no audio, just generate" | n/a | EN | `edge-tts` (Aria/Guy) |

## After capture — using the voice

Every squad that produces video calls:

```javascript
const { listVoiceReferences, generate } = require(`${process.env.CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/client.js`);
const voices = listVoiceReferences();
const voice = voices.find(v => v.name === 'guto') || voices[0];

const result = await generate({
  text: '...',
  framePreset: 'instagram-reel',
  ttsWorkflow: 'f5-tts-pt-br',           // chosen per the rules above
  refAudioPath: voice.path,              // ← the captured voice
  promptPrefix: 'cinematic',
});
console.log(result.video_url);
```
