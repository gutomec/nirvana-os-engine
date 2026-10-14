/* Nirvana-OS site: the theme toggle every page shares. Loaded in <head>
   without defer, so a saved theme applies before the first paint. */
(function () {
  "use strict";
  var root = document.documentElement;
  var KEY = "nrv-theme";
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);
  } catch (e) { /* private window, blocked storage: the page works without it */ }

  function current() {
    var t = root.getAttribute("data-theme");
    if (t) return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function label(btn) {
    btn.setAttribute("aria-label", current() === "dark" ? "Mudar para o tema claro" : "Mudar para o tema escuro");
  }
  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("tt");
    if (!btn) return;
    label(btn);
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      label(btn);
    });
  });
})();
