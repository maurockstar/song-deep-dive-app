// Song Deep Dive — Internationalization (i18n)
// Supports English and Spanish
(function () {
  "use strict";

  var translations = {
    en: {
      "brand.name": "g<span class=\"e3\">eee</span>k",
      "btn.connectSpotify": "Connect Spotify",
      "btn.connected": "Connected ✓",
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
      "brand.name": "g<span class=\"e3\">eee</span>k",
      "btn.connectSpotify": "Conectar Spotify",
      "btn.connected": "Conectado ✓",
      "btn.dive": "Bucear",
      "btn.logout": "Cerrar Sesión",
      "search.placeholder": "O busca una canción para sumergirte…",
      "empty.welcome.h1": "Obsesiónate con la música que amas.",
      "empty.welcome.p": "Conecta Spotify (o busca una canción) y descubriremos la historia detrás, quién la hizo y cómo se conecta con todo lo demás.",
      "empty.noResults.h1": "Sin buceo profundo aún",
      "empty.noResults.p": "No pudimos armar este. Intenta con otra canción.",
      "empty.error.h1": "Hmm.",
      "empty.error.p": "No se pudo alcanzar el servicio de buceo profundo. Intenta de nuevo en un momento.",
      "status.notConnected": "no conectado",
      "status.connected": "conectado",
      "status.enriching": "enriqueciendo con IA…",
      "status.ready": "listo",
      "state.playing": "▶ reproduciendo",
      "state.paused": "❚❚ pausado",
      "skeleton.kicker": "cargando",
      "skeleton.title": "Reuniendo la historia…",
      "skeleton.body": "un momento",
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
