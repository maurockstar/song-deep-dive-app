// geeek — Internationalization (i18n)
// Supports English and Spanish
(function () {
  "use strict";

  var translations = {
    en: {
      "brand.name": "g<span class=\"e3\">eee</span>k",
      "btn.connectSpotify": "Connect Spotify",
      "btn.connected": "Connected to Spotify ✓",
      "btn.dive": "Dive",
      "btn.logout": "Logout",
      "search.placeholder": "Or search a song to dive into…",
      "empty.welcome.h1": "Geek out about the music you love.",
      "empty.welcome.p": "Connect Spotify (or search a song) and we'll surface the story behind it, who made it, and how it connects to everything else.",
      "empty.noResults.h1": "No deep dive yet",
      "empty.noResults.p": "We couldn't assemble this one. Try another song.",
      "empty.error.h1": "Hmm.",
      "empty.error.p": "Couldn't reach the deep-dive service. Try again in a moment.",
      "status.notConnected": "not connected",
      "status.connected": "connected",
      "status.enriching": "enriching with AI…",
      "status.ready": "ready",
      "state.playing": "▶ playing",
      "state.paused": "❚❚ paused",
      "skeleton.kicker": "loading",
      "skeleton.title": "Gathering the story…",
      "skeleton.body": "one moment",
      "version": "Geeek · v"
    },
    es: {
      // Voz Geeek en español (CEdO 2026-07-07): cálida, latinoamericana, de amigo — nunca traducción literal.
      // Base es-419: tú, frases cortas, diminutivos con cariño, cero calcos ("bucear" jamás). Guía completa:
      // Geeek\12_Editorial_CEdO\Geeek - Spanish Voice & LatAm Market Study (CEdO).md
      "brand.name": "g<span class=\"e3\">eee</span>k",
      "btn.connectSpotify": "Conectar Spotify",
      "btn.connected": "Conectado a Spotify ✓",
      "btn.dive": "A fondo",
      "btn.logout": "Cerrar sesión",
      "search.placeholder": "O busca una canción y nos vamos a fondo…",
      "empty.welcome.h1": "Ponte geek con la música que amas.",
      "empty.welcome.p": "Conecta Spotify (o busca una canción) y te contamos su historia: quién la hizo, de dónde viene y con qué se conecta.",
      "empty.noResults.h1": "Todavía no tenemos esta historia",
      "empty.noResults.p": "Esta se nos escapó. Prueba con otra canción.",
      "empty.error.h1": "Uy.",
      "empty.error.p": "No pudimos traer la historia ahora. Dale otra oportunidad en un momentito.",
      "status.notConnected": "sin conectar",
      "status.connected": "conectado",
      "status.enriching": "afinando con IA…",
      "status.ready": "listo",
      "state.playing": "▶ sonando",
      "state.paused": "❚❚ en pausa",
      "skeleton.kicker": "cargando",
      "skeleton.title": "Armando la historia…",
      "skeleton.body": "un momentito",
      "version": "Geeek · v"
    }
  };

  var currentLang = localStorage.getItem("sdd:lang") || "en";

  function setLanguage(lang) {
    if (!translations[lang]) lang = "en";
    currentLang = lang;
    localStorage.setItem("sdd:lang", lang);
    document.documentElement.lang = lang;
    if (window.SDD && window.SDD.ui && window.SDD.ui.onLanguageChange) {
      window.SDD.ui.onLanguageChange();
    }
  }

  function t(key) {
    var dict = translations[currentLang] || translations.en;
    return (dict && dict[key]) || key;
  }

  function getLanguage() {
    return currentLang;
  }

  function getAvailableLanguages() {
    return ["en", "es"];
  }

  window.SDD = window.SDD || {};
  window.SDD.i18n = {
    t: t,
    setLanguage: setLanguage,
    getLanguage: getLanguage,
    getAvailableLanguages: getAvailableLanguages,
    currentLang: currentLang
  };
})();
