<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: جملة واحدة تدخل، وعمل منجز يخرج. سير عمل وكلاء متوازية تلتقي عبر بوابات الجودة." width="100%">

# Nirvana-OS

**عمليات وكلاء جاهزة للتشغيل.** جملة واحدة تدخل. عمل منجز يخرج.

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS وLinux وWSL**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[التوثيق](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [التثبيت المصوّر](https://gutomec.github.io/nirvana-os-engine/install.html) · [إصدار بيتا](https://gutomec.github.io/nirvana-os-engine/beta.html) · [Changelog](./CHANGELOG.md)

**اقرأ هذا بلغتك:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## أنت تتحدث إلى وكيلك. ووكيلك يشغّل Nirvana.

أنت تعمل بالفعل مع وكيل في الطرفية: Claude Code أو Codex أو Antigravity أو Pi أو Grok أو غيرها. موجّه واحد يعطي جواباً جيداً واحداً. العمل الحقيقي يتطلب باحثاً وكاتباً ومراجعاً ومشغّلاً، مع سجل يبيّن من فعل ماذا.

يمنح Nirvana-OS وكيلك هذا التنظيم. تطلب بلغة بسيطة، فيستخدم الوكيل Nirvana لاختيار الشركات وsquads وmind-clones المناسبة، وتوزيعها، والتحقق مما يعود منها، وعرض الإيصال عليك. لا تتعلم واجهة جديدة ولا تكتب أوامر في عملك اليومي. الأوامر الواردة أدناه هي المرجع الذي يستخدمه وكيلك، وهي متاحة لك متى أردتها.

## ما هو

Nirvana-OS نظام متعدد الوكلاء، أصيل في Bun ومستقل عن بيئة التشغيل. يعمل فوق الوكيل الذي تستخدمه أصلاً ولا يحل محله أبداً. يتعامل مع ثلاثة أنواع من المحتوى، وكلها مجلدات على جهازك:

| الركيزة | ما هي | أين تعيش |
|---|---|---|
| **الشركات (businesses)** | مؤسسات لها هيكل تنظيمي من الموظفين (المقاعد). الشركة التي يجري توزيعها تشغّل مقاعدها، وهذه تستدعي squads وتستحضر mind-clones | `~/businesses/` |
| **Squads** | فرق وكلاء قابلة للنقل، فيها وكلاء ومهام وسير عمل يتبعها الوكيل الموزَّع منهجاً له | `~/squads/` |
| **Mind-clones** | حمض نووي للشخصية في خمس طبقات، ليفكّر الوكيل ويكتب بمنهج خبير بعينه | `~/businesses/_library/dna/` |

يأتي المحرك بلا محتوى. تنشئ الشركات وsquads والنسخ بطلب ذلك من وكيلك، أو تثبّت حزمة من [squads.sh](https://squads.sh/pt/packs).

## التثبيت

شغّل الأمر ذا السطر الواحد في أعلى هذه الصفحة: سطر `bash` على macOS وLinux وWSL، وسطر PowerShell على Windows. لا حاجة إلى Node. إذا لم يكن [Bun](https://bun.sh) موجوداً، يضعه المثبّت في مجلد المستخدم (`~/.bun`) دون sudo ودون صلاحيات المسؤول ويتابع عمله.

قبل التشغيل:

- **macOS:** لا شيء للتحضير.
- **Windows (PowerShell):** لا شيء للتحضير، ودون صلاحيات المسؤول.
- **Linux (Ubuntu):** `sudo apt update && sudo apt install -y curl unzip`.
- **Windows مع WSL (Ubuntu):** شغّل `wsl --install` في PowerShell مفتوح بصلاحيات المسؤول، وأعد التشغيل، وافتح تطبيق Ubuntu وأنشئ مستخدم Linux الخاص بك. ثم ثبّت `curl` و`unzip` كما في Linux وشغّل سطر `bash` داخل Ubuntu. يجب أن يُثبَّت وكيل الذكاء الاصطناعي لديك (Claude Code أو Codex أو Antigravity) داخل Ubuntu أيضاً، ومكان مشاريعك هو `~` لا `/mnt/c`، فهو بطيء.

ما يغيّره على جهازك:

- المحرك في `~/.nirvana/skills`؛
- الـ skill المسماة `nirvana`، مربوطة بكل بيئة تشغيل وكلاء يعثر عليها: `~/.claude/skills` و`~/.codex/skills` و`~/.gemini/config/skills` (Antigravity) و`~/.pi/agent/skills` و`~/.agents/skills` (OpenClaw)؛
- `nrv` و`nrv-hermes` في `~/.local/bin`، مع سطر PATH واحد في ملف تعريف الصدفة لديك (PATH الخاص بالمستخدم على Windows)؛
- خطافات تدقيق في Claude Code وAntigravity وCodex؛
- مجلدات المحتوى الفارغة `~/squads` و`~/businesses` و`~/businesses/_library/dna`.

إعادة تشغيله آمنة. **أغلق الطرفية وافتح واحدة جديدة** ليصبح `nrv` على PATH لديك، وتحقّق بالأمر `nrv --version`. ثم اطلب من وكيلك: *"تحقق من أن Nirvana-OS مثبّت بشكل صحيح."* فيشغّل `nrv doctor`. رمز الخروج 1 يعني تحذيرات فقط؛ والرمز 2 يسرد ما فشل.

الدليل خطوة بخطوة لكل نظام، والإصدار التجريبي، وحل المشكلات موجودة في [موقع التوثيق](https://gutomec.github.io/nirvana-os-engine/install.html) (بالبرتغالية) وفي [INSTALL.md](./INSTALL.md)، مع الطرق الأخرى (الـ skill المسماة `nirvana` عبر skills.sh، والتثبيت من نسخة مستنسخة).

## ابدأ مشروعاً

افتح المجلد الذي تريد العمل فيه، وشغّل وكيلك هناك، وقل: *"جهّز هذا المجلد كمشروع Nirvana-OS."* يشغّل الوكيل `nrv init .`، الذي يكتب `.nirvana/project.yaml`، وملف `.env` فيه نطاق مكتبة المشروع، وعقد المشروع في `AGENTS.md` و`CLAUDE.md` و`GEMINI.md`. تصل المخرجات إلى `outputs/` داخل المشروع.

في 0.14.11 يجعل هذا العقد Nirvana منسّقاً لكل مُخرَج ملموس في المشروع: اطلب تقريراً أو صفحة أو حملة فيسلّمها وكيلك إلى Nirvana. إذا أردت Nirvana فقط حين تطلبه بالاسم، فقل ذلك عند تجهيز المشروع (*"جهّز هذا المجلد كمشروع Nirvana، عند الطلب فقط"*). يشغّل الوكيل `nrv init . --orchestrators=on-demand`، الذي يكتب ملاحظة قصيرة بدلاً من العقد الكامل. وحين تشغّل `nrv init .` بنفسك في طرفية، في مجلد يحتوي أصلاً على أحد هذه الملفات، يسألك أي وضع تستخدم. الإصدار التجريبي 0.15 يعكس ذلك: الوضع عند الطلب هو الافتراضي، و`--orchestrators=always` يفعّل التنسيق الكامل.

بعد ذلك تتحدث إلى وكيلك بلغة طبيعية وهو يستخدم Nirvana-OS. لا تكتب أوامر في عملك اليومي.

## ماذا تطلب من وكيلك

| تقول | يشغّل وكيلك |
|---|---|
| "ما الشركات / squads / mind-clones التي أملكها؟" | `nrv list-businesses`، `nrv list-squads`، `nrv list-clones` |
| "استخدم Nirvana لكتابة نص الإطلاق الإعلاني لـ X." | الـ harness: يختار الشركات وsquads، ويكتب لها موجزاتها، ويوزّعها |
| "شغّل هذا عبر squad الكتابة الإعلانية، على Codex." | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| "غيّر العنوان الرئيسي فيما سلّمته." | `nrv revise <project> "<change>"` |
| "أرني ما فعله ذلك التشغيل." | `nrv audit-view <project>` |
| "ثبّت تبعيات كل squads لديّ." | `nrv activate --all` |
| "حدّث Nirvana-OS." | `nrv update` |
| "حدّث حزمة Genesis Circle لديّ." | `nrv update genesis-circle` |
| "حدّد سقف كل تشغيل بـ US$ 5." | `nrv config set budget.default_max_cost_usd 5 --global` |

الطلبات الأكبر تعمل بالطريقة نفسها:

```text
استخدم Nirvana-OS لإنشاء شركة اسمها podcast-empire تنتج 3 بودكاستات في آن واحد
وتنشرها وتحقق منها الدخل. لكل برنامج تخصصه الخاص، ومقدّم بالذكاء الاصطناعي، وتقويم
تحريري، وقمع مستقل لتحقيق الدخل. نحو 7 موظفين.
```

```text
استخدم Nirvana-OS لتحويل النتاج العام لـ <author> إلى mind-clone كامل بالذكاء الاصطناعي.
```

```text
استخدم Nirvana-OS لإنتاج حزمة إطلاق: بحث سوق، ونص إعلاني لصفحة هبوط،
وتحليل تنافسي مفصّل.
```

ينسّق الوكيل ولا يكتب المُخرَج بنفسه أبداً. يختار الشركات وsquads، ويكتب لكل منها موجزاً مُثرى، ويوزّعها، بالتوازي حين تكون الأجزاء مستقلة.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="أمر نثري واحد يدخل، فيتجمّع تكتّل ذكاء اصطناعي كامل ويسلّم" width="100%">
</div>

## الحزم

الحزم شركات وsquads وmind-clones منتقاة تُباع على [squads.sh](https://squads.sh/pt/packs). الحزمة الرئيسية هي [Genesis Circle](https://squads.sh/pt/nirvana-os).

1. اشترِ الحزمة على squads.sh ونزّل ملف zip الخاص بها من لوحة التحكم.
2. فكّ ضغط الأرشيف كاملاً وافتح طرفية في المجلد الذي يحتوي على `setup.sh`:
   - macOS: انقر نقراً مزدوجاً على ملف zip، واكتب `cd ` (مع المسافة) في Terminal، واسحب المجلد إلى النافذة واضغط Enter؛
   - Windows: انقر بزر الفأرة الأيمن على ملف zip، واختر **Extract All**، وافتح المجلد، وانقر بزر الفأرة الأيمن على مساحة فارغة واختر **Open in Terminal**؛
   - Linux وWSL: `cd ~/Downloads && unzip <file>.zip -d <folder> && cd <folder>`. على WSL، انسخ ملف zip أولاً من `/mnt/c/Users/<user>/Downloads` إلى `~/Downloads`.
3. شغّل الإعداد:
   - macOS وLinux وWSL: `bash setup.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1`

   يثبّت الإعداد Bun عند الحاجة، ويثبّت المحرك أو يحدّثه، وينسخ المحتوى إلى `~/squads` و`~/businesses` و`~/businesses/_library/dna`، ويعيد بناء الفهارس، ويحفظ ترخيص الحزمة في `~/.nirvana-license/packs/<pack>/`. ولا يستبدل المحرك أبداً بإصدار أقدم، فيبقى الإصدار التجريبي تجريبياً.
4. تحدّث إلى وكيلك: *"استخدم Nirvana لتسرد ما قدّمته لي حزمة Genesis Circle"*، ثم اطلب العمل بتسمية شركة أو squad أو الحزمة.

**تفعيل الـ squads.** تُثبَّت اعتماديات الـ squad عند الطلب في أول مرة يعمل فيها، في بيئته الخاصة ضمن `~/.nirvana/envs/<squad>`. لتجهيزها كلها مسبقاً، اطلب من وكيلك: *"فعّل كل squads الخاصة بي في Nirvana."* فيشغّل `nrv activate --all`، الذي يغطي حزم Node وPython، وبرامج النظام، ومفاتيح API ومتغيرات البيئة، وخوادم MCP، والنماذج. يتلقى الوكيل قائمة الإخفاقات مع الأمر الدقيق الذي يصلح كل واحد منها، ويطلب إذنك قبل أي شيء يستخدم `brew` أو `sudo` أو `winget`، ولأي مفتاح API. أول تشغيل على حزمة كبيرة يستغرق عدة دقائق.

**تحديث حزمة.** اطلب من وكيلك تحديثها، أو شغّل `nrv update <pack-slug>`، مثلاً `nrv update genesis-circle`. المكوّنات التي عدّلتها تُنسخ احتياطياً في `~/.nirvana/backups/packs/<pack>/` قبل أن يستبدلها التحديث. إذا فشل التحديث بخطأ في الترخيص، فنزّل الحزمة مجدداً من squads.sh وشغّل إعدادها مرة أخرى؛ فهذا يجدّد الترخيص أيضاً.

## تحديث المحرك

اطلب من وكيلك تحديث Nirvana-OS، أو شغّل `nrv update`. ينسخ `~/.nirvana/skills` احتياطياً أولاً ويحتفظ بإعداداتك ومحتواك. يذكر `nrv update --check` الإصدار الذي سيثبّته دون أن يغيّر شيئاً.

لا يعيد التحديث المحرك أبداً إلى إصدار أقدم. المحرك المستقر ينتقل فقط إلى إصدار مستقر أحدث. والإصدار التجريبي ينتقل إلى أحدث إصدار أكبر، تجريبياً كان أو مستقراً، فيصبح الإصدار التجريبي من 0.15 هو 0.15.0 عند صدوره. بعد تحديث المحرك، يفحص `nrv update` أيضاً كل حزمة مثبّتة لها ترخيص ويخبرك حين يتوفر لها إصدار أحدث.

## إصدارات بيتا

إصدارات بيتا هي prereleases على GitHub. الأمر ذو السطر الواحد يثبّت أحدث إصدار مستقر، لذا يُثبَّت إصدار بيتا بتثبيت ملف tarball الخاص به. إصدار بيتا الحالي هو `v0.15.0-beta.8`. يبدأ الوسم بالحرف `v`؛ ومن دونه يعيد التنزيل 404. لإصدار بيتا أحدث، استبدل هذا الوسم بوسم من [قائمة الإصدارات](https://github.com/gutomec/nirvana-os-engine/releases).

macOS وLinux وWSL:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.8/nirvana-os-engine.tar.gz bash
```

Windows (PowerShell)، في سطر واحد:

```powershell
$env:NIRVANA_ENGINE_URL='https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.8/nirvana-os-engine.tar.gz'; irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

بعد ذلك، إن بقيت النافذة مفتوحة، شغّل `Remove-Item Env:NIRVANA_ENGINE_URL`: ما دام المتغير موجوداً، يعيد `nrv update` تثبيت ملف tarball المثبَّت. تستخدم أوامر Windows علامات اقتباس مفردة لأن علامة اقتباس مزدوجة تضيع أثناء اللصق تترك PowerShell منتظراً عند `>>`.

يجلب إصدار بيتا ملفات تعريف الأداء (`max` و`balanced` و`economy`) ويجعل `nrv init` عند الطلب افتراضياً. وبمجرد أن تكون على إصدار بيتا، يبقيك `nrv update` وكل إعداد حزمة على قناة بيتا.

**العودة إلى الإصدار المستقر.** على Windows، افتح PowerShell جديداً أولاً وشغّل `Remove-Item Env:NIRVANA_ENGINE_URL`؛ ولا بأس بخطأ يقول إنه غير موجود. شغّل الأمر البسيط من أعلى هذه الصفحة. يثبّت أحدث إصدار مستقر فوق إصدار بيتا ويحتفظ بمحتواك وحزمك وإعداداتك. تحقّق من أن `nrv --version` لم يعد يُظهر `beta`، ثم أعد تشغيل `nrv init .` في كل مشروع استخدمته مع إصدار بيتا، بعد إزالة الكتلة التي كتبها إصدار بيتا في `AGENTS.md` و`CLAUDE.md` و`GEMINI.md` ([التفاصيل](./INSTALL.md#back-to-stable-from-a-beta)).

## الإعدادات

تتغيّر الإعدادات حين تطلب. يكفي أن تقول *"ما المضبوط حالياً؟"* أو *"حدّد سقف كل تشغيل بـ US$ 5"* أو *"عطّل المُحكِّم الآلي"*؛ فيشغّل وكيلك `nrv config` ويخبرك بما تغيّر. يعرض `nrv config list` كل إعداد وقيمته ومصدره: متغير بيئة، أو `.nirvana/config.yaml` الخاص بالمشروع، أو `~/.nirvana/config.yaml` الخاص بك، أو المحرك، أو القيمة الافتراضية. ملفك العام يبقى بعد كل تحديث.

لا يُضبط افتراضياً أي نموذج ولا أي مستوى جهد، فتستخدم كل بيئة تشغيل إعداداتها الخاصة. المرجع الكامل في [docs/configuration.md](./docs/configuration.md).

**لكل مشروع.** يحدّد `nrv config set briefing.altitude <outcome|guided|prescriptive> --project` مقدار ما يحمله الموجز (brief): القيمة الافتراضية `outcome` تذكر النتيجة والقيود وتعريف الإنجاز؛ و`guided` تضيف البنية التي يقترحها المؤلف؛ و`prescriptive` تضيف معايير لكل بند وقائمة المخرجات والطريقة. يعرض `nrv config get briefing.altitude` القيمة السارية. القواعد المكتوبة بنص حر توضع في `CLAUDE.md` أو `AGENTS.md` أو `GEMINI.md` الخاص بالمشروع، فوق كتلة Nirvana التي يعيد `nrv init` كتابتها؛ يقرؤها وكيلك وينقلها إلى الموجزات التي يكتبها. يكفي أن تطلب: *"في هذا المشروع، استخدم موجزات guided"*، *"أضف إلى CLAUDE.md في هذا المشروع: كل مُخرَج بالبرتغالية البرازيلية"*.

## لماذا لعبارة "العمل منجز" معنى هنا

يمكن للمنسّق أن يعلن أي شيء في رسالته الأخيرة. يسند Nirvana-OS كل تسليم بأشياء يمكنك فتحها على القرص.

- **مسار التدقيق.** كل توزيع وحكم بوابة وتسليم هو حدث بالإلحاق فقط في `~/.harness-logs/<date>/audit.jsonl`. كل تشغيل بـ `--exec` يترك أيضاً سجلاً في `.nirvana/run-kernel.sqlite` الخاص بالمشروع. يعرض `nrv audit-view <project>` السلسلة كاملة.
- **متحقَّق منه على القرص.** يقارن `verify-deliverable` ما وعد به الموجز بالملفات الموجودة فعلاً، وتشغّل بوابة الجودة معايير تقييم لكل نوع ملف، مع جولات تصحيح عند الإخفاق. التشغيل الذي تصمد إخفاقاته الجسيمة بعد التصحيحات يُحجب ولا يُسلَّم.
- **مُقيَّم وفق الموجز.** تسلّم البوابة الموجز إلى المُحكِّم، فيُحاسَب المُخرَج على ما طُلب منه، لا على معايير تقييم عامة فحسب.
- **الإنفاق تحت سيطرتك.** لا يُضبط أي سقف للتكلفة ما لم تطلبه (*"حدّد سقف كل تشغيل بـ US$ 5"* يضبط `budget.default_max_cost_usd`).

## مرجع الأوامر

للوكلاء والمستخدمين المتقدمين. يسرد `nrv help` كل شيء؛ ويعطي `nrv <command> --help` خيارات كل أمر. المرجع الكامل: [docs/CLI.md](./docs/CLI.md).

| الأمر | ما يفعله |
|---|---|
| `nrv doctor` | فحص السلامة: بيئات التشغيل، والخطافات، وروابط skills، والتبعيات، والسجلات، والتراخيص |
| `nrv init <dir>` | يجعل مجلداً مشروع Nirvana (`--orchestrators=on-demand\|always`، `--scope=project\|merge`) |
| `nrv list-businesses` / `list-squads` / `list-clones` | تصفّح السجلات الثلاثة |
| `nrv find "<need>"` / `nrv search "<topic>"` | مرشحون مرتّبون لطلب ما / بحث بالكلمات المفتاحية عبر المكتبات |
| `nrv dispatch <business> "<brief>" --exec` | تشغيل شركة على موجز؛ `--squad <slug>` أو `--agent-x` أو `--auto` تسمّي أهدافاً أخرى. من دون `--exec` يكتفي بإعداد الهيكل |
| `nrv run-track status\|wait <run>` | قراءة حالة تشغيل، أو انتظار انتهائه |
| `nrv revise <project> "<change>"` | تغيير تسليم في جلسة بيئة التشغيل نفسها |
| `nrv audit-view <project>` | سلسلة التدقيق لتشغيل ما |
| `nrv activate <squad>\|--all` | تجهيز بيئة squad مسبقاً في `~/.nirvana/envs/<squad>` |
| `nrv config list\|get\|set\|unset\|explain` | الإعدادات، مع `--global` أو `--project` |
| `nrv update [--check]` / `nrv update <pack>` | تحديث المحرك / حزمة |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | بوابة قبول لكيان واحد |
| `nrv glance` | قمرة قيادة على الويب (`--read-only` للتصفح فقط) |
| `nrv uninstall --engine` | إزالة المحرك مع الإبقاء على محتواك |

## الأسئلة الشائعة

**هل أحتاج إلى معرفة البرمجة؟** لا. تصف النتائج بلغة بسيطة؛ ووكيلك يشغّل Nirvana، والشركات وsquads تكتب وتتحقق وتسلّم.

**هل يحل محل وكيلي؟** لا. يعمل فوقه. العمل الموزَّع يجري على بيئة تشغيل جلستك ما لم تسمِّ غيرها: Claude Code أو Codex أو Antigravity أو Pi أو Kimi أو Grok.

**أين يعيش عملي؟** على جهازك: المحتوى في `~/businesses` و`~/squads` و`~/businesses/_library/dna`، والمخرجات في `outputs/` الخاص بكل مشروع. لا توجد سحابة Nirvana في الحلقة.

**ماذا لو لم يناسب أي شيء في مكتبتي؟** يعمل الطلب رغم ذلك، على `agent-x`، الوكيل العام. ويمكنك أيضاً أن تطلب من وكيلك إنشاء الشركة أو الـ squad الناقصة.

**Windows؟** أصلي، عبر Bun، دون حاجة إلى WSL. إذا كنت تفضّل WSL، فثبّت كل شيء داخل Ubuntu، بما في ذلك وكيلك.

## حل المشكلات

- **يُظهر PowerShell العلامة `>>` وينتظر.** بقيت علامة اقتباس مفتوحة أثناء اللصق. اضغط Ctrl+C أو افتح نافذة جديدة، ثم الصق السطر الواحد مجدداً.
- **يُظهر macOS العبارة "Saving session… [Processo concluído]" بعد إغلاق Terminal.** هذا Terminal يغلق الصدفة، وليس خطأ.
- **يعيد التثبيت 404.** ينقص الوسمَ الحرفُ `v` في أوله، أو أن ذلك الإصدار غير موجود.
- **يفشل تحديث حزمة بخطأ في الترخيص.** نزّل الحزمة مجدداً من squads.sh وشغّل إعدادها.
- **أي شيء آخر.** يفحص `nrv doctor` التثبيت كله ويفحص `nrv install --check` الخطافات وPATH. المزيد في [INSTALL.md](./INSTALL.md#troubleshooting).

## الترخيص والتأليف والحالة

المؤلف: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. لا مؤلفين مشاركين.

الترخيص: Nirvana-OS Sustainable Use License (SUL) v1.0. المصدر منشور ومقروء علناً، والمحرك مجاني الاستخدام. إنه متاح المصدر، لا ترخيص مفتوح المصدر معتمداً من OSI، وبعض الاستخدامات التجارية تتطلب ترخيصاً تجارياً منفصلاً. اقرأ [LICENSE](./LICENSE) قبل الاعتماد على أي ملخص، بما في ذلك هذا.

الحالة: بيتا (0.x، حالياً 0.14.13). المحرك يعمل اليوم ويُثبَّت في دقائق. توقّع أن تستمر الواجهة في التغيّر حتى الإصدار 1.0.
