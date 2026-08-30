<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: جملة واحدة تدخل، وعمل منجز يخرج. سير عمل وكلاء متوازية تلتقي عبر بوابات الجودة." width="100%">

# Nirvana-OS

**عمليات وكلاء جاهزة للتشغيل.** جملة واحدة تدخل. عمل منجز يخرج.

[![npm downloads](https://img.shields.io/npm/dm/@nirvana-os/cli)](https://www.npmjs.com/package/@nirvana-os/cli)
[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@nirvana-os/cli?label=npm)](https://www.npmjs.com/package/@nirvana-os/cli)

```bash
npx @nirvana-os/cli
```

أمر واحد يثبّت المحرك ويربطه بكل وكيل طرفية يعثر عليه. تشغيله مجدداً آمن في أي وقت.

[التوثيق](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [التثبيت المصوّر](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**اقرأ هذا بلغتك:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## وكيلك حاد الذكاء. وهو وحيد أيضاً.

أنت تشغّل بالفعل وكيلاً في الطرفية: Claude Code أو Codex أو Gemini-CLI أو Antigravity. موجّه واحد يعطي جواباً جيداً واحداً. العمل الحقيقي ليس موجّهاً واحداً. إنه باحث وكاتب ومراجع ومشغّل يشدّون في الاتجاه نفسه، بالتوازي، مع سجل مكتوب لكل خطوة. اليوم، أنت الصمغ.

يرقّي Nirvana-OS هذا الوكيل المنفرد إلى مايسترو يدير مؤسسات كاملة. تصف النتيجة بنثر بسيط. يقرأ المحرك الموجز، ويراجع ما تملكه، ويوزّع الشركات وsquads وmind-clones بالتوازي، ويوفّق كل شيء خلف بوابة جودة، ويكتب مسار تدقيق لكل عملية توزيع. تكفّ عن كونك المشغّل وتصبح المدير.

الواجهة كلها نثر مع إيصال. أنت تتكلم. ووكيلك يشغّل الأوامر.

## ما هو

Nirvana-OS نظام تشغيل متعدد الوكلاء، أصيل في Bun ومستقل عن بيئة التشغيل. ينشئ تكتّلاً ويديره ويشرف عليه: أي عدد من الشركات وsquads، منسّقة من الموجز حتى التسليم المتحقق منه. إنه طبقة التنسيق فوق وكيل الطرفية لديك، لا بديلاً عنه.

الوضع الافتراضي هو **صفر بشر**: تعمل الشركات باستقلالية، والمدخلات البشرية اختيارية عبر محفّزات صريحة في البيان. أنت تذكر النتيجة. والمحرك يختار الطاقم.

كل ما ينشئه هو واحد من ثلاثة أشياء:

| الركيزة | ما هي | أين تعيش |
|---|---|---|
| **الشركات (businesses)** | مؤسسات مستقلة بهيكل تنظيمي من موظفين دائمين يستدعون squads | `~/businesses/` |
| **Squads** | فرق وكلاء قابلة للنقل تشغّل سير عمل حقيقياً: DAG وبوابات جودة وتصعيد | `~/squads/` |
| **Mind-clones** | حمض نووي للشخصية في 5 طبقات، يُحقن في الموظفين ليفكّروا ويتحدّثوا بمنهج أحد كبار الخبراء | `~/businesses/_library/dna/` |

الشركة تنسّق الموظفين. الموظف يستدعي squads. الـ squad يشغّل وكلاء. الـ mind-clone يمنح أياً منهم صوتاً أصدق. موجز واحد يمكنه أن يحشد كثيراً منها دفعة واحدة.

## البداية السريعة

ما تحتاجه: [Bun](https://bun.sh) 1.0 أو أحدث. Node 18+ و`tar` موجودان فقط ليعمل `npx`، ومعظم الأجهزة تملكهما بالفعل.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
exec $SHELL
npx @nirvana-os/cli

# Windows (native, no WSL), in PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
# open a NEW PowerShell window so PATH refreshes
npx @nirvana-os/cli
```

يضع المثبّت شجرة skills واحدة في `~/.nirvana/skills`، ويربطها بـ `~/.claude` و`~/.codex` و`~/.gemini` و`~/.antigravity` حيثما وجدها، ويضع ثنائيات `nrv` على PATH لديك. يثبّت المحرك ولا محتوى: سجلاتك تبدأ فارغة عن قصد، فكل ما فيها شيء بنيته أنت أو اخترت تثبيته. إعادة تشغيل المثبّت متكررة الأثر (idempotent) وتجلب دائماً أحدث محرك.

تأكد من سلامة التثبيت:

```bash
nrv doctor
```

على Windows، يفحص `nrv doctor` أيضاً PATH الخاص بالمستخدم بحثاً عن مدخلات `nrv-*` المؤقتة التي كانت المحركات حتى الإصدار 0.8.0 قد تخلّفها. يسردها `nrv install --repair-path` دون كتابة أي شيء؛ و`--apply` يزيل تلك بالضبط ويبقي كل مدخل آخر كما هو.

ثم افتح وكيلك وقل **"استخدم Nirvana-OS لـ…"**. للإعداد الذي يقوده الوكيل، وجّه بيئة التشغيل لديك إلى [`AGENT-QUICKSTART.md`](./AGENT-QUICKSTART.md).

## عرض 90 ثانية

> **الموضع محجوز.** الجولة القياسية ذات الـ 90 ثانية تُضمَّن هنا فور نشرها. حتى ذلك الحين، هذه هي اللقطة الحيّة لأمر نثري واحد يجمّع تكتّلاً.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="أمر نثري واحد يدخل، فيتجمّع تكتّل ذكاء اصطناعي كامل ويسلّم" width="100%">
</div>

<!-- DEMO-90s SLOT
     Canonical 90-second demo goes here when published (trace 75fbfbcc, phase X3).
     Replace the block above with:
     <a href="VIDEO_URL"><img src="THUMBNAIL_URL" alt="Nirvana-OS في 90 ثانية" width="100%"></a>
-->

## شاهده يعمل: كل شيء جملة

**ابنِ شركة بوصفها.** يصمّم النظام المؤسسة، ويكتب كل موظف، ويوصّل سير العمل، ويتحقق من النتيجة وفق Business Protocol.

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

**استنسخ خبيراً بالنثر.** يستخرج مصنع العباقرة حمضاً نووياً من 5 طبقات (فلسفات، ونماذج ذهنية، وقواعد إرشادية، وأطر عمل، ومنهجيات) من النتاج العام لشخص ما، مع إسناد كل عنصر إلى مصدره.

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

**جملة واحدة، فرق كثيرة دفعة واحدة.** موجز واحد يمكنه أن يستدعي squad بحث وsquad كتابة إعلانية وشركة تصميم بالتوازي، موفَّقة خلف بوابة جودة واحدة، مع مسار تدقيق يُظهر كل خيار اتخذه المايسترو.

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

مزيد من التدفقات، ومنها "صمّم الوكالة، واستنسخ المتخصصين، وابنِها" في ثلاثة أسئلة، موجودة في [الصفحة الرئيسية للتوثيق](https://gutomec.github.io/nirvana-os-engine/)، التي تشغّل الجملة نفسها عبر بيئات التشغيل السبع المدعومة: Claude Code وCodex وGemini وAntigravity وGrok وKimi وHermes.

## لماذا لعبارة "العمل منجز" معنى هنا

للأنظمة متعددة الوكلاء مشكلة ثقة: يمكن للمنسّق أن يعلن أي شيء في رسالته الأخيرة. يجيب Nirvana-OS بثلاثة ضمانات، كل منها مسنود بآلية يمكنك فتحها على القرص.

- **قابل للتتبع.** كل إجراء يصبح حدثاً بالإلحاق فقط في `~/.harness-logs/<date>/audit.jsonl`: استلام الموجز، والتوزيع، وحقن mind-clone، واجتياز البوابة أو الإخفاق فيها. كل تشغيل بـ `--exec`، في وضع `standard` أو عبر Gauntlet، يترك أيضاً Run قياسياً في `.nirvana/run-kernel.sqlite` الخاص بالمشروع، وهو سجل بالإلحاق فقط يقرؤه Glance. من دون هذه الأحداث، لا رسالة إنجاز صادقة.
- **مختبَر.** يقارن `verify-deliverable.ts` ما وعد به الموجز بما هو موجود فعلاً على القرص. ويشغّل `quality-gate.ts` معايير تقييم لكل نوع ملف في حلقة حكم ونقد ومراجعة. لا PASS من verify، لا إنجاز مشروع.
- **متعاقد عليه.** للمهام معايير قبول ثنائية. وللقدرات مدخلات ومخرجات منمّطة. المخرجات الموجّهة للعميل تمر بسلسلة اعتماد: المنتِج، ثم المراجع، ثم المعتمِد. الميزانيات سقف صارم، ومحفّزات التصعيد تحدد بالضبط متى يدخل الإنسان الحلقة.

## المحرك مجاني، والمحتوى مدفوع

المحرك في هذا المستودع مجاني، بلا مستوى مبتور ولا شيء أساسي محجوب. ينشئ وينسّق الشركات وsquads وmind-clones من الصفر. المصدر منشور ومقروء علناً بموجب [Sustainable Use License](./LICENSE) (متاح المصدر، وليس معتمداً من OSI؛ بعض الاستخدامات التجارية تتطلب ترخيصاً منفصلاً).

الطبقة المدفوعة هي **محتوى لا قدرة**: مجموعات منتقاة جاهزة للتشغيل، تُسلَّم عبر [squads.sh](https://squads.sh). الفارق الذي تشتريه لك الحزم هو الوقت، لا القوة. تصفّحها في **[squads.sh/pt/packs](https://squads.sh/pt/packs)**. الباقة الرائدة، **[Genesis Circle](https://squads.sh/pt/nirvana-os)**، تسلّمك تكتّلاً كاملاً يمكنك تشغيله من اليوم الأول، ويُبقى محدثاً بـ `nrv update <pack>`.

| | المحرك المجاني (هذا المستودع) | Packs ([squads.sh/pt/packs](https://squads.sh/pt/packs)) |
|---|---|---|
| الإنشاء من الصفر | نعم | نعم |
| التنسيق بالتوازي | نعم | نعم |
| مسار تدقيق لكل عملية توزيع | نعم | نعم |
| squads وشركات وmind-clones جاهزة | لا شيء، فارغ عن قصد | تكتّل كامل من اليوم الأول |

## حفنة الأوامر التي تستحق أن تكتبها بنفسك

| ما تكتبه | ما يفعله |
|---|---|
| `npx @nirvana-os/cli` | يثبّت المحرك أو يحدّثه (متكرر الأثر) |
| `nrv glance` | قمرة قيادة على الويب: الشركات وsquads والنسخ والتدقيق والتكاليف. في مشروع مُتبنّى، تشغّل رسالة Message في الدردشة عملية توزيع حقيقية في عملية فرعية، مع خط زمني حيّ وإلغاء واستعادة بعد إعادة التشغيل. `--read-only` يبقيه للتصفح فقط |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | تصفّح السجلات الثلاثة |
| `nrv search "<topic>"` | العثور على القدرات عبر السجلات الثلاثة كلها |
| `nrv dispatch --business <slug> \| --squad <slug> \| --agent-x "<brief>" --exec` | تشغيل موجز على هدف تسمّيه أنت؛ لا يُستشار الموجّه أبداً |
| `nrv run <business> "<brief>" --execution-mode=gauntlet --gauntlet-intensity=light\|balanced\|exhaustive` | الانضمام إلى Gauntlet: مرشحون وتقييمات وجولات مراجعة بثلاث شدّات (أهداف Business تحتاج `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST`) |
| `nrv multi-target plan\|run\|status <plan.json>` | تجميع خطة متعددة الأهداف أو تنفيذها أو فحصها فوق Run Kernel (`NIRVANA_MULTI_TARGET_KILL_SWITCH=1` يعطّل `run`) |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | بوابة قبول لكيان واحد، أو `--all` لكل الكيانات المثبّتة؛ و`--fix` يصلح ما يمكن إصلاحه دون اختلاق شيء |
| `nrv migrate <slug> --to 6 [--apply]` | يحوّل squad إلى Squad Protocol 6.0؛ التشغيل التجريبي هو الافتراضي، و`--apply` يكتب مع نسخة احتياطية |
| `nrv update <pack>` | تحديث حزمة مثبّتة |
| `nrv doctor` | فحص التثبيت؛ على Windows، ينظّف `nrv install --repair-path` مدخلات PATH الخاصة بالمستخدم التي يحذّر منها |

كل ما عدا ذلك يشغّله وكيلك. المرجع الكامل: [docs/CLI.md](./docs/CLI.md).

## الأسئلة الشائعة

**هل أحتاج إلى معرفة البرمجة؟** لا. تصف النتائج بلغة بسيطة؛ والنظام يكتب الشيفرة ويتحقق منها ويشغّلها.

**هل يحل محل وكيلي؟** لا. يعمل فوق Claude Code أو Codex أو Gemini-CLI أو Antigravity، ويجعل الوكيل الذي تملكه ينسّق كثيرين.

**أين يعيش عملي؟** على جهازك، تحت `~/businesses` و`~/squads` و`~/businesses/_library/dna`. محلي أولاً، من دون أي سحابة طرف ثالث في الحلقة.

**ماذا لو لم يستطع النظام فعل ما أطلبه؟** يقول ذلك. الموجز الذي لا يطابق شيئاً يتلقى رفضاً مع اقتراح بإنشاء القدرة الناقصة. والموجز الغامض يتلقى سؤالاً في المقابل، مع أفضل المرشحين.

**Windows؟** أصلي، عبر Bun. لا حاجة إلى WSL.

## الترخيص والتأليف والحالة

المؤلف: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. لا مؤلفين مشاركين.

الترخيص: Nirvana-OS Sustainable Use License (SUL) v1.0. المصدر منشور ومقروء علناً، والمحرك مجاني الاستخدام. إنه متاح المصدر، لا ترخيص مفتوح المصدر معتمداً من OSI، وبعض الاستخدامات التجارية تتطلب ترخيصاً تجارياً منفصلاً. اقرأ [LICENSE](./LICENSE) قبل الاعتماد على أي ملخص، بما في ذلك هذا.

الحالة: بيتا (0.x، حالياً 0.12.4). المحرك يعمل اليوم ويُثبَّت في دقائق. توقّع أن تستمر الواجهة في التغيّر حتى الإصدار 1.0.
