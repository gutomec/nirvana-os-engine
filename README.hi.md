<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: एक वाक्य अंदर, तैयार काम बाहर। समानांतर एजेंट workflows क्वालिटी गेट से होकर एक जगह मिलते हैं।" width="100%">

# Nirvana-OS

**चलाने के लिए तैयार एजेंटिक ऑपरेशंस।** एक वाक्य अंदर। तैयार काम बाहर।

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS, Linux और WSL**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[दस्तावेज़ीकरण](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [सचित्र इंस्टॉल](https://gutomec.github.io/nirvana-os-engine/install.html) · [Beta](https://gutomec.github.io/nirvana-os-engine/beta.html) · [Changelog](./CHANGELOG.md)

**इसे अपनी भाषा में पढ़ें:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## आप अपने एजेंट से बात करते हैं। आपका एजेंट Nirvana चलाता है।

आप पहले से एक टर्मिनल एजेंट के साथ काम करते हैं: Claude Code, Codex, Antigravity, Pi, Grok या कोई और। एक प्रॉम्प्ट से एक अच्छा जवाब मिलता है। असली काम के लिए एक शोधकर्ता, एक लेखक, एक समीक्षक और एक ऑपरेटर चाहिए, साथ में इसका रिकॉर्ड कि किसने क्या किया।

Nirvana-OS आपके एजेंट को वह संगठन देता है। आप सादी भाषा में माँगते हैं, और एजेंट Nirvana का उपयोग करके सही कंपनियाँ, squads और mind-clones चुनता है, उन्हें डिस्पैच करता है, जो लौटकर आता है उसे जाँचता है और आपको रसीद दिखाता है। आपको कोई नया इंटरफ़ेस नहीं सीखना पड़ता और रोज़मर्रा में कमांड टाइप नहीं करनी पड़तीं। नीचे दी गई कमांड वह संदर्भ हैं जिसका आपका एजेंट उपयोग करता है, और जब आप चाहें तब वे आपके लिए भी मौजूद हैं।

## यह क्या है

Nirvana-OS एक Bun-नेटिव, रनटाइम-अज्ञेय मल्टी-एजेंट सिस्टम है। यह उस एजेंट के ऊपर चलता है जिसे आप पहले से इस्तेमाल करते हैं और कभी उसकी जगह नहीं लेता। यह तीन तरह के कंटेंट के साथ काम करता है, और तीनों आपकी मशीन पर फ़ोल्डर हैं:

| स्तंभ | यह क्या है | यह कहाँ रहता है |
|---|---|---|
| **कंपनियाँ (businesses)** | कर्मचारियों (सीटों) के संगठन चार्ट वाले संगठन। डिस्पैच की गई कंपनी अपनी सीटें चलाती है, जो squads को बुलाती हैं और mind-clones को चैनल करती हैं | `~/businesses/` |
| **Squads** | पोर्टेबल एजेंट टीमें, जिनमें एजेंट, tasks और workflows हैं जिन्हें डिस्पैच किया गया एजेंट अपनी पद्धति के रूप में अपनाता है | `~/squads/` |
| **Mind-clones** | पाँच परतों में पर्सोना DNA, ताकि एक एजेंट किसी ख़ास विशेषज्ञ की पद्धति से सोचे और लिखे | `~/businesses/_library/dna/` |

इंजन बिना कंटेंट के आता है। आप अपने एजेंट से कहकर कंपनियाँ, squads और clones बनाते हैं, या [squads.sh](https://squads.sh/pt/packs) से एक pack इंस्टॉल करते हैं।

## इंस्टॉल

इस पेज के ऊपर दी गई एक-लाइन कमांड चलाएँ: macOS, Linux और WSL पर `bash` वाली लाइन, Windows पर PowerShell वाली लाइन। Node की ज़रूरत नहीं है। अगर [Bun](https://bun.sh) नहीं है, तो इंस्टॉलर उसे बिना sudo और बिना एडमिन अधिकारों के आपके यूज़र फ़ोल्डर (`~/.bun`) में रख देता है और आगे बढ़ता है।

चलाने से पहले:

- **macOS:** कुछ तैयार नहीं करना है।
- **Windows (PowerShell):** कुछ तैयार नहीं करना है, और एडमिन अधिकारों की ज़रूरत नहीं।
- **Linux (Ubuntu):** `sudo apt update && sudo apt install -y curl unzip`।
- **Windows के साथ WSL (Ubuntu):** एडमिन के रूप में खोले गए PowerShell में `wsl --install` चलाएँ, रीबूट करें, Ubuntu ऐप खोलें और अपना Linux यूज़र बनाएँ। फिर Linux की तरह `curl` और `unzip` इंस्टॉल करें और Ubuntu के अंदर `bash` वाली लाइन चलाएँ। आपका AI एजेंट (Claude Code, Codex, Antigravity) भी Ubuntu के अंदर ही इंस्टॉल होना चाहिए, और आपके प्रोजेक्ट `~` में रहें, `/mnt/c` में नहीं, जो धीमा है।

यह आपकी मशीन पर क्या बदलता है:

- इंजन, `~/.nirvana/skills` में;
- `nirvana` skill, उसे मिलने वाले हर एजेंट रनटाइम से जोड़ी गई: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills` (Antigravity), `~/.pi/agent/skills` और `~/.agents/skills` (OpenClaw);
- `nrv` और `nrv-hermes`, `~/.local/bin` में, साथ में आपकी shell प्रोफ़ाइल में PATH की एक लाइन (Windows पर यूज़र PATH);
- Claude Code, Antigravity और Codex में ऑडिट hooks;
- खाली कंटेंट फ़ोल्डर `~/squads`, `~/businesses` और `~/businesses/_library/dna`।

इसे दोबारा चलाना सुरक्षित है। **टर्मिनल बंद करें और नया खोलें** ताकि `nrv` आपके PATH पर हो, और `nrv --version` से जाँचें। फिर अपने एजेंट से कहें: *"जाँचो कि Nirvana-OS सही तरह से इंस्टॉल हुआ है।"* वह `nrv doctor` चलाता है। Exit 1 का मतलब सिर्फ़ चेतावनियाँ है; exit 2 बताता है कि क्या फ़ेल हुआ।

हर सिस्टम के लिए चरण-दर-चरण गाइड, beta और समस्या-निवारण [डॉक्यूमेंटेशन साइट](https://gutomec.github.io/nirvana-os-engine/install.html) (पुर्तगाली में) और [INSTALL.md](./INSTALL.md) में हैं, साथ में दूसरे रास्ते भी (skills.sh के ज़रिए `nirvana` skill, क्लोन से इंस्टॉल)।

## प्रोजेक्ट शुरू करें

जिस फ़ोल्डर में काम करना है उसे खोलें, वहाँ अपना एजेंट शुरू करें और कहें: *"इस फ़ोल्डर को Nirvana-OS प्रोजेक्ट के रूप में सेट करो।"* एजेंट `nrv init .` चलाता है, जो `.nirvana/project.yaml`, प्रोजेक्ट की लाइब्रेरी स्कोप वाली एक `.env`, और `AGENTS.md`, `CLAUDE.md` और `GEMINI.md` में प्रोजेक्ट का कॉन्ट्रैक्ट लिखता है। डिलिवरेबल प्रोजेक्ट के अंदर `outputs/` में आते हैं।

0.14.11 पर वह कॉन्ट्रैक्ट Nirvana को प्रोजेक्ट के हर ठोस डिलिवरेबल का ऑर्केस्ट्रेटर बना देता है: रिपोर्ट, पेज या कैंपेन माँगें और आपका एजेंट उसे Nirvana को सौंप देता है। अगर आप Nirvana को सिर्फ़ तब चाहते हैं जब आप उसका नाम लें, तो प्रोजेक्ट सेट करते समय यह बताएँ (*"इस फ़ोल्डर को Nirvana प्रोजेक्ट के रूप में सेट करो, सिर्फ़ माँगने पर"*)। एजेंट `nrv init . --orchestrators=on-demand` चलाता है, जो पूरे कॉन्ट्रैक्ट की जगह एक छोटा नोट लिखता है। जब आप खुद किसी टर्मिनल में, ऐसे फ़ोल्डर में जिसमें इनमें से कोई फ़ाइल पहले से हो, `nrv init .` चलाते हैं, तो वह पूछता है कि कौन-सा मोड इस्तेमाल करना है। 0.15 beta इसे उलट देता है: on-demand डिफ़ॉल्ट है, और `--orchestrators=always` पूरा ऑर्केस्ट्रेशन चालू करता है।

इसके बाद आप सादी भाषा में अपने एजेंट से बात करते हैं और वह Nirvana-OS इस्तेमाल करता है। रोज़मर्रा में आप कमांड टाइप नहीं करते।

## अपने एजेंट से क्या कहें

| आप कहते हैं | आपका एजेंट चलाता है |
|---|---|
| "मेरे पास कौन-सी कंपनियाँ / squads / mind-clones हैं?" | `nrv list-businesses`, `nrv list-squads`, `nrv list-clones` |
| "Nirvana का उपयोग करके X के लिए लॉन्च copy लिखो।" | harness: कंपनियाँ और squads चुनता है, उनके लिए ब्रीफ़ लिखता है और उन्हें डिस्पैच करता है |
| "इसे copy squad से चलाओ, Codex पर।" | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| "जो तुमने डिलिवर किया उसमें हेडलाइन बदलो।" | `nrv revise <project> "<change>"` |
| "मुझे दिखाओ कि उस रन ने क्या किया।" | `nrv audit-view <project>` |
| "मेरे सभी squads की dependencies इंस्टॉल करो।" | `nrv activate --all` |
| "Nirvana-OS अपडेट करो।" | `nrv update` |
| "मेरा Genesis Circle pack अपडेट करो।" | `nrv update genesis-circle` |
| "हर रन को US$ 5 तक सीमित करो।" | `nrv config set budget.default_max_cost_usd 5 --global` |

बड़े अनुरोध भी इसी तरह काम करते हैं:

```text
Nirvana-OS का उपयोग करके podcast-empire नाम की एक कंपनी बनाओ जो एक साथ 3 पॉडकास्ट
बनाए, प्रकाशित करे और उनसे कमाई करे। हर शो का अपना niche, एक AI होस्ट, एक
संपादकीय कैलेंडर और एक स्वतंत्र मुद्रीकरण फ़नल हो। लगभग 7 कर्मचारी।
```

```text
Nirvana-OS का उपयोग करके <author> के सार्वजनिक काम को एक पूरे AI mind-clone में बदलो।
```

```text
Nirvana-OS का उपयोग करके एक लॉन्च पैकेज तैयार करो: मार्केट रिसर्च, लैंडिंग पेज की copy
और एक विस्तृत प्रतिस्पर्धी विश्लेषण।
```

एजेंट ऑर्केस्ट्रेट करता है और डिलिवरेबल ख़ुद कभी नहीं लिखता। वह कंपनियाँ और squads चुनता है, हर एक के लिए एक समृद्ध ब्रीफ़ लिखता है और उन्हें डिस्पैच करता है, और जब हिस्से एक-दूसरे से स्वतंत्र हों तो समानांतर में।

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="एक गद्य आदेश अंदर, एक पूरा AI समूह जुड़ता है और डिलिवर करता है" width="100%">
</div>

## Packs

Packs क्यूरेट की गई कंपनियाँ, squads और mind-clones हैं, जो [squads.sh](https://squads.sh/pt/packs) पर बिकते हैं। फ़्लैगशिप [Genesis Circle](https://squads.sh/pt/nirvana-os) है।

1. squads.sh पर pack ख़रीदें और अपने डैशबोर्ड से उसकी zip डाउनलोड करें।
2. पूरा आर्काइव अनज़िप करें और उस फ़ोल्डर में टर्मिनल खोलें जिसमें `setup.sh` है:
   - macOS: zip पर डबल-क्लिक करें, Terminal में `cd ` (स्पेस के साथ) टाइप करें, फ़ोल्डर को विंडो पर खींचें और Enter दबाएँ;
   - Windows: zip पर राइट-क्लिक करें, **Extract All** चुनें, फ़ोल्डर खोलें, किसी खाली जगह पर राइट-क्लिक करें और **Open in Terminal** चुनें;
   - Linux और WSL: `cd ~/Downloads && unzip <फ़ाइल>.zip -d <फ़ोल्डर> && cd <फ़ोल्डर>`। WSL पर पहले zip को `/mnt/c/Users/<यूज़र>/Downloads` से `~/Downloads` में कॉपी करें।
3. setup चलाएँ:
   - macOS, Linux और WSL: `bash setup.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1`

   setup ज़रूरत हो तो Bun इंस्टॉल करता है, इंजन इंस्टॉल या अपडेट करता है, कंटेंट को `~/squads`, `~/businesses` और `~/businesses/_library/dna` में कॉपी करता है, इंडेक्स दोबारा बनाता है और pack का लाइसेंस `~/.nirvana-license/packs/<pack>/` में रखता है। वह इंजन को कभी पुराने release से नहीं बदलता, इसलिए beta, beta ही रहता है।
4. अपने एजेंट से बात करें: *"Nirvana से बताओ कि Genesis Circle pack ने मुझे क्या दिया"*, फिर किसी कंपनी, squad या pack का नाम लेकर काम माँगें।

**Squads को सक्रिय करना।** किसी squad की dependencies उसके पहली बार चलने पर, ज़रूरत के हिसाब से, उसके अपने environment `~/.nirvana/envs/<squad>` में इंस्टॉल होती हैं। सबको पहले से तैयार करने के लिए अपने एजेंट से कहें: *"मेरे सारे Nirvana squads सक्रिय करो।"* वह `nrv activate --all` चलाता है, जो Node और Python पैकेज, सिस्टम प्रोग्राम, API keys और environment variables, MCP सर्वर और मॉडल कवर करता है। एजेंट को विफलताओं की सूची मिलती है, हर एक के साथ उसे ठीक करने वाली सटीक कमांड; `brew`, `sudo` या `winget` इस्तेमाल करने वाली किसी भी चीज़ से पहले, और किसी भी API key के लिए, वह आपकी अनुमति माँगता है। बड़े pack पर पहली बार चलाने में कई मिनट लगते हैं।

**Pack अपडेट करना।** अपने एजेंट से उसे अपडेट करने को कहें, या `nrv update <pack-slug>` चलाएँ, उदाहरण के लिए `nrv update genesis-circle`। आपने जिन components में बदलाव किए हैं, अपडेट उन्हें बदलने से पहले उनका बैकअप `~/.nirvana/backups/packs/<pack>/` में लेता है। अगर अपडेट लाइसेंस त्रुटि के साथ फ़ेल हो, तो squads.sh से pack दोबारा डाउनलोड करें और उसका setup एक बार और चलाएँ; इससे लाइसेंस भी रिफ़्रेश हो जाता है।

## इंजन अपडेट करना

अपने एजेंट से Nirvana-OS अपडेट करने को कहें, या `nrv update` चलाएँ। यह पहले `~/.nirvana/skills` का बैकअप लेता है और आपकी सेटिंग्स और कंटेंट रखता है। `nrv update --check` बिना कुछ बदले बताता है कि वह कौन-सा release इंस्टॉल करेगा।

अपडेट इंजन को कभी पुराने release पर नहीं ले जाता। स्टेबल इंजन सिर्फ़ नए स्टेबल पर जाता है। Beta सबसे नए बड़े release पर जाता है, beta हो या स्टेबल, इसलिए 0.15 का beta 0.15.0 आने पर 0.15.0 बन जाता है। इंजन अपडेट के बाद `nrv update` लाइसेंस वाले हर इंस्टॉल किए गए pack की भी जाँच करता है और नया वर्ज़न होने पर बताता है।

## Betas

Betas GitHub पर prereleases हैं। एक-लाइन कमांड नवीनतम स्टेबल इंस्टॉल करती है, इसलिए beta उसका tarball पिन करके इंस्टॉल होता है। मौजूदा beta `v0.15.0-beta.8` है। टैग की शुरुआत `v` से होती है; उसके बिना डाउनलोड 404 देता है। किसी नए beta के लिए, इस टैग को [release सूची](https://github.com/gutomec/nirvana-os-engine/releases) के टैग से बदलें।

macOS, Linux और WSL:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.8/nirvana-os-engine.tar.gz bash
```

Windows (PowerShell), एक ही लाइन में:

```powershell
$env:NIRVANA_ENGINE_URL='https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.8/nirvana-os-engine.tar.gz'; irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

इसके बाद, अगर विंडो अब भी खुली है, तो `Remove-Item Env:NIRVANA_ENGINE_URL` चलाएँ: जब तक यह variable मौजूद है, `nrv update` पिन किया गया tarball दोबारा इंस्टॉल करता है। Windows कमांड single quotes इस्तेमाल करती हैं, क्योंकि पेस्ट में खोया हुआ double quote PowerShell को `>>` पर इंतज़ार करता छोड़ देता है।

Beta परफ़ॉर्मेंस प्रोफ़ाइल (`max`, `balanced`, `economy`) लाता है और `nrv init` को डिफ़ॉल्ट रूप से on-demand बनाता है। एक बार beta पर आने के बाद, `nrv update` और हर pack setup आपको beta चैनल पर रखते हैं।

**स्टेबल पर वापस जाना।** Windows पर, पहले एक नया PowerShell खोलें और `Remove-Item Env:NIRVANA_ENGINE_URL` चलाएँ; यह कहने वाली त्रुटि कि यह मौजूद नहीं है, ठीक है। इस पेज के ऊपर दी गई सामान्य एक-लाइन कमांड चलाएँ। यह beta के ऊपर नवीनतम स्टेबल इंस्टॉल करती है और आपका कंटेंट, packs और सेटिंग्स रखती है। जाँचें कि `nrv --version` अब `beta` नहीं दिखाता, फिर beta के साथ इस्तेमाल किए हर प्रोजेक्ट में, beta ने `AGENTS.md`, `CLAUDE.md` और `GEMINI.md` में जो ब्लॉक लिखा था उसे हटाकर, `nrv init .` दोबारा चलाएँ ([विवरण](./INSTALL.md#back-to-stable-from-a-beta))।

## सेटिंग्स

सेटिंग्स तब बदलती हैं जब आप कहते हैं। *"क्या कॉन्फ़िगर है?"*, *"हर रन को US$ 5 तक सीमित करो"* या *"AI जज बंद करो"* काफ़ी हैं; आपका एजेंट `nrv config` चलाता है और बताता है कि क्या बदला। `nrv config list` हर सेटिंग, उसका मान और वह कहाँ से आई, यह दिखाता है: एक environment variable, प्रोजेक्ट की `.nirvana/config.yaml`, आपकी `~/.nirvana/config.yaml`, इंजन या डिफ़ॉल्ट। आपकी ग्लोबल फ़ाइल हर अपडेट के बाद बनी रहती है।

डिफ़ॉल्ट रूप से न कोई मॉडल सेट होता है और न कोई प्रयास, इसलिए हर रनटाइम अपनी कॉन्फ़िगरेशन इस्तेमाल करता है। पूरा संदर्भ [docs/configuration.md](./docs/configuration.md) है।

**प्रति प्रोजेक्ट।** `nrv config set briefing.altitude <outcome|guided|prescriptive> --project` तय करता है कि एक brief कितना कुछ ले जाता है: डिफ़ॉल्ट `outcome` परिणाम, सीमाएँ और पूरा होने की परिभाषा बताता है; `guided` लेखक की सुझाई संरचना जोड़ता है; `prescriptive` हर आइटम के मानदंड, artifacts की सूची और तरीका जोड़ता है। `nrv config get briefing.altitude` लागू मान दिखाता है। मुक्त-पाठ वाले नियम प्रोजेक्ट की `CLAUDE.md`, `AGENTS.md` या `GEMINI.md` में जाते हैं, उस Nirvana ब्लॉक के ऊपर जिसे `nrv init` दोबारा लिखता है; आपका एजेंट उन्हें पढ़ता है और अपने लिखे briefs में ले जाता है। कह देना काफ़ी है: *"इस प्रोजेक्ट में guided briefs इस्तेमाल करो"*, *"इस प्रोजेक्ट की CLAUDE.md में जोड़ो: हर डिलिवरेबल ब्राज़ीलियाई पुर्तगाली में"*।

## यहाँ "काम हो गया" का मतलब कुछ क्यों है

एक ऑर्केस्ट्रेटर अपने अंतिम संदेश में कुछ भी घोषित कर सकता है। Nirvana-OS हर डिलिवरी के पीछे ऐसी चीज़ें रखता है जिन्हें आप डिस्क पर खोल सकते हैं।

- **ऑडिट ट्रेल।** हर डिस्पैच, गेट का फ़ैसला और डिलिवरी `~/.harness-logs/<date>/audit.jsonl` में एक append-only इवेंट है। हर `--exec` रन प्रोजेक्ट के `.nirvana/run-kernel.sqlite` में भी एक रिकॉर्ड छोड़ता है। `nrv audit-view <project>` यह श्रृंखला दिखाता है।
- **डिस्क पर जाँचा हुआ।** `verify-deliverable` ब्रीफ़ के वादे की तुलना मौजूद फ़ाइलों से करता है, और क्वालिटी गेट फ़ाइल प्रकार के अनुसार rubrics चलाता है, फ़ेल होने पर सुधार के दौर के साथ। जिस रन की गंभीर विफलताएँ सुधारों के बाद भी बची रहें, उसे रोक लिया जाता है और डिलिवर नहीं किया जाता।
- **ब्रीफ़ के आधार पर आँका हुआ।** गेट ब्रीफ़ को अपने जज को सौंपता है, इसलिए डिलिवरेबल को उसी पर परखा जाता है जो माँगा गया था, सिर्फ़ किसी सामान्य rubric पर नहीं।
- **ख़र्च आपके नियंत्रण में।** जब तक आप न माँगें, कोई लागत सीमा सेट नहीं होती (*"हर रन को US$ 5 तक सीमित करो"* `budget.default_max_cost_usd` सेट करता है)।

## कमांड संदर्भ

एजेंटों और पावर यूज़र्स के लिए। `nrv help` सब कुछ सूचीबद्ध करता है; `nrv <command> --help` हर कमांड के विकल्प देता है। पूरा संदर्भ: [docs/CLI.md](./docs/CLI.md)।

| कमांड | यह क्या करता है |
|---|---|
| `nrv doctor` | स्वास्थ्य जाँच: रनटाइम, hooks, skills लिंक, dependencies, रजिस्ट्रियाँ, लाइसेंस |
| `nrv init <dir>` | किसी फ़ोल्डर को Nirvana प्रोजेक्ट बनाता है (`--orchestrators=on-demand\|always`, `--scope=project\|merge`) |
| `nrv list-businesses` / `list-squads` / `list-clones` | तीनों रजिस्ट्रियाँ ब्राउज़ करता है |
| `nrv find "<need>"` / `nrv search "<topic>"` | किसी अनुरोध के लिए रैंक किए गए उम्मीदवार / लाइब्रेरियों में कीवर्ड खोज |
| `nrv dispatch <business> "<brief>" --exec` | एक ब्रीफ़ पर एक कंपनी चलाता है; `--squad <slug>`, `--agent-x` या `--auto` दूसरे लक्ष्य बताते हैं। `--exec` के बिना यह सिर्फ़ ढाँचा बनाता है |
| `nrv run-track status\|wait <run>` | किसी रन की स्थिति पढ़ता है, या उसके पूरा होने का इंतज़ार करता है |
| `nrv revise <project> "<change>"` | उसी रनटाइम सत्र में एक डिलिवरी बदलता है |
| `nrv audit-view <project>` | एक रन की ऑडिट श्रृंखला |
| `nrv activate <squad>\|--all` | किसी squad का environment पहले से `~/.nirvana/envs/<squad>` में तैयार करता है |
| `nrv config list\|get\|set\|unset\|explain` | सेटिंग्स, `--global` या `--project` के साथ |
| `nrv update [--check]` / `nrv update <pack>` | इंजन / एक pack अपडेट करता है |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | एक एंटिटी का प्रवेश द्वार |
| `nrv glance` | वेब कॉकपिट (सिर्फ़ ब्राउज़ करने के लिए `--read-only`) |
| `nrv uninstall --engine` | इंजन हटाता है और आपका कंटेंट रखता है |

## FAQ

**क्या मुझे कोड करना आना चाहिए?** नहीं। आप सादी भाषा में परिणाम बताते हैं; आपका एजेंट Nirvana चलाता है, और कंपनियाँ और squads लिखते, जाँचते और डिलिवर करते हैं।

**क्या यह मेरे एजेंट की जगह लेता है?** नहीं। यह उसके ऊपर चलता है। डिस्पैच किया गया काम आपके सत्र के रनटाइम पर चलता है, जब तक आप कोई दूसरा न बताएँ: Claude Code, Codex, Antigravity, Pi, Kimi या Grok।

**मेरा काम कहाँ रहता है?** आपकी मशीन पर: कंटेंट `~/businesses`, `~/squads` और `~/businesses/_library/dna` में, डिलिवरेबल हर प्रोजेक्ट के `outputs/` में। लूप में कोई Nirvana क्लाउड नहीं है।

**अगर मेरी लाइब्रेरी में कुछ भी फ़िट न हो?** अनुरोध फिर भी चलता है, `agent-x` पर, जो सामान्य-उद्देश्य वाला एजेंट है। आप अपने एजेंट से वह कंपनी या squad बनाने को भी कह सकते हैं जो मौजूद नहीं है।

**Windows?** नेटिव, Bun के ज़रिए, WSL की ज़रूरत नहीं। अगर आप WSL पसंद करते हैं, तो सब कुछ Ubuntu के अंदर इंस्टॉल करें, अपने एजेंट समेत।

## समस्या-निवारण

- **PowerShell `>>` दिखाता है और इंतज़ार करता है।** पेस्ट में कोई quote खुला रह गया। Ctrl+C दबाएँ या नई विंडो खोलें, फिर वही एक लाइन दोबारा पेस्ट करें।
- **Terminal बंद करने के बाद macOS "Saving session… [Processo concluído]" दिखाता है।** यह Terminal का shell बंद करना है, कोई त्रुटि नहीं।
- **इंस्टॉल 404 देता है।** टैग की शुरुआत में `v` नहीं है, या वह release मौजूद नहीं है।
- **Pack अपडेट लाइसेंस त्रुटि के साथ फ़ेल होता है।** squads.sh से pack दोबारा डाउनलोड करें और उसका setup चलाएँ।
- **कुछ और।** `nrv doctor` पूरे इंस्टॉल की जाँच करता है और `nrv install --check` hooks और PATH की। ज़्यादा जानकारी [INSTALL.md](./INSTALL.md#troubleshooting) में।

## लाइसेंस, लेखकत्व और स्थिति

लेखक: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**। कोई सह-लेखक नहीं।

लाइसेंस: Nirvana-OS Sustainable Use License (SUL) v1.0। स्रोत प्रकाशित और खुले तौर पर पठनीय है, और इंजन उपयोग के लिए मुफ़्त है। यह source-available है, OSI-अनुमोदित ओपन-सोर्स लाइसेंस नहीं, और कुछ व्यावसायिक उपयोगों के लिए अलग व्यावसायिक लाइसेंस चाहिए। किसी भी सारांश पर, इस पर भी, भरोसा करने से पहले [LICENSE](./LICENSE) पढ़ें।

स्थिति: beta (0.x, अभी 0.14.13)। इंजन आज काम करता है और मिनटों में इंस्टॉल होता है। 1.0 तक सतह के बदलते रहने की उम्मीद रखें।
