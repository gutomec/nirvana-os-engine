/* Nirvana-OS guide pages (install.html, beta.html): operating system tabs,
   copy buttons and the beta tag; the theme toggle lives in site.js. Plain JS,
   no dependencies. Without JS the pages still work: every panel shows under
   its own heading and every command is selectable text. */
(function () {
  "use strict";

  /* The current beta, in ONE place. Each page also writes it as the fallback
     text of its .beta-tag spans, so a release means: change this constant and
     find-and-replace the old tag in docs/install.html and docs/beta.html. */
  var BETA_TAG = "v0.15.0-beta.12";

  var root = document.documentElement;
  root.classList.add("js");

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* private window, blocked storage: the page works without it */ }
    return null;
  }

  /* Beta tag */
  Array.prototype.forEach.call(document.querySelectorAll(".beta-tag"), function (el) { el.textContent = BETA_TAG; });

  /* Operating system tabs. Every group on the page follows the same choice. */
  var OS_NAMES = { mac: "macOS", win: "Windows", wsl: "WSL", linux: "Linux" };
  var groups = Array.prototype.slice.call(document.querySelectorAll("[data-tabs]"));
  function guessOs() {
    var ua = (navigator.userAgent || "") + " " + (navigator.platform || "");
    if (/Windows|Win32|Win64/i.test(ua)) return "win";
    if (/Mac/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "mac";
    if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
    return "mac";
  }
  function select(os, focus) {
    groups.forEach(function (group) {
      var tabs = group.querySelectorAll("[role=tab]");
      Array.prototype.forEach.call(tabs, function (tab) {
        var on = tab.getAttribute("data-os") === os;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(tab.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
        if (on && focus === group) tab.focus();
      });
    });
    store("nrv-guide-os", os);
  }
  groups.forEach(function (group) {
    var list = group.querySelector("[role=tablist]");
    if (!list) return;
    list.addEventListener("click", function (e) {
      var tab = e.target.closest("[role=tab]");
      if (tab) select(tab.getAttribute("data-os"));
    });
    list.addEventListener("keydown", function (e) {
      var tabs = Array.prototype.slice.call(list.querySelectorAll("[role=tab]"));
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var j = null;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      if (j === null) return;
      e.preventDefault();
      select(tabs[j].getAttribute("data-os"), group);
    });
  });
  if (groups.length) {
    var savedOs = store("nrv-guide-os");
    select(OS_NAMES[savedOs] ? savedOs : guessOs());
  }

  /* Copy buttons on every command block */
  function copyText(text, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else {
      fallback(text, done);
    }
  }
  function fallback(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* the text stays selectable by hand */ }
    document.body.removeChild(ta);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".code pre"), function (pre) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "copiar";
    btn.setAttribute("aria-label", "Copiar comando");
    btn.addEventListener("click", function () {
      copyText(pre.textContent.replace(/\n+$/, ""), function () {
        btn.textContent = "copiado";
        btn.classList.add("done");
        setTimeout(function () { btn.textContent = "copiar"; btn.classList.remove("done"); }, 1600);
      });
    });
    pre.parentNode.appendChild(btn);
  });
})();
