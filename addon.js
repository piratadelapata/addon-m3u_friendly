const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const fs      = require("fs");
const { parseM3U, groupContent, cleanTitleForTMDB, slugify } = require("./parse-m3u");

const app  = express();
const PORT = process.env.PORT || 7000;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

// ─────────────────────────────────────────────
// CONFIG STORE — persiste en disco
// Sobrevive reinicios de Render
// ─────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, "configs.json");

function loadConfigStore() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      console.log(`📂 ${Object.keys(data).length} configs cargadas desde disco`);
      return new Map(Object.entries(data));
    }
  } catch (err) {
    console.error("❌ Error cargando configs desde disco:", err.message);
  }
  return new Map();
}

function persistConfigStore() {
  try {
    const obj = Object.fromEntries(configStore);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Error guardando configs en disco:", err.message);
  }
}

const configStore = loadConfigStore();

function saveConfig(config) {
  const id = crypto
    .createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 12);
  configStore.set(id, config);
  persistConfigStore();
  return id;
}

function getConfig(id) {
  return configStore.get(id) || null;
}

let globalData = {
  movies:          [],
  series:          {},
  tmdbCache:       {},
  movieImdbIndex:  {},
  seriesImdbIndex: {},
  apiKey:          null,
  configId:        null,
  ready:           false
};

function normalize(str = "") {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/1080p|720p|2160p|4k|hdr|webrip|bluray|x264|x265/gi, "")
    .replace(/latino|castellano|dual|subtitulado|sub/gi, "")
    .replace(/s\d{1,2}e\d{1,2}/gi, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function searchTMDB(title, type, tmdbCache, apiKey) {
  if (!apiKey) return null;
  const clean = normalize(cleanTitleForTMDB(title));
  if (clean in tmdbCache) return tmdbCache[clean];
  try {
    const endpoint  = type === "series" ? "tv" : "movie";
    const searchRes = await fetch(
      `https://api.themoviedb.org/3/search/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(clean)}&language=es-MX`
    );
    const data = await searchRes.json();
    if (!data.results?.length) { tmdbCache[clean] = null; return null; }
    const detRes = await fetch(
      `https://api.themoviedb.org/3/${endpoint}/${data.results[0].id}/external_ids?api_key=${apiKey}`
    );
    const det  = await detRes.json();
    const imdb = det.imdb_id || null;
    tmdbCache[clean] = imdb;
    return imdb;
  } catch {
    tmdbCache[clean] = null;
    return null;
  }
}

function chunks(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

async function prefetchTMDB(data) {
  const { movies, series, tmdbCache, movieImdbIndex, seriesImdbIndex, apiKey } = data;
  if (!apiKey) return;

  const movieList  = movies.filter(m => !m.id.startsWith("tt"));
  const seriesList = Object.values(series).filter(s => !s.id.startsWith("tt"));

  console.log(`⏳ Pre-carga TMDB iniciada`);
  console.log(`🎬 ${movieList.length} películas`);
  console.log(`📺 ${seriesList.length} series`);

  let resolvedMovies = 0;
  let resolvedSeries = 0;

  for (const batch of chunks(movieList, 4)) {
    await Promise.all(batch.map(async movie => {
      try {
        const imdb = await searchTMDB(movie.title, "movie", tmdbCache, apiKey);
        if (imdb) { movieImdbIndex[imdb] = movie.id; movie.id = imdb; resolvedMovies++; }
      } catch (err) {
        console.error(`❌ TMDB movie error: ${movie.title}`);
      }
    }));
    console.log(`🎬 Películas resueltas: ${resolvedMovies}/${movieList.length}`);
    await sleep(400);
  }

  console.log(`✅ Películas terminadas`);

  for (const batch of chunks(seriesList, 4)) {
    await Promise.all(batch.map(async show => {
      try {
        const imdb = await searchTMDB(show.title, "series", tmdbCache, apiKey);
        if (imdb) { seriesImdbIndex[imdb] = show.id; show.id = imdb; resolvedSeries++; }
      } catch (err) {
        console.error(`❌ TMDB series error: ${show.title}`);
      }
    }));
    console.log(`📺 Series resueltas: ${resolvedSeries}/${seriesList.length}`);
    await sleep(400);
  }

  console.log(`✅ Pre-carga TMDB completada`);
}

async function loadList(m3uUrls) {
  let allItems = [];
  for (const url of m3uUrls) {
    try {
      console.log(`📥 Descargando: ${url}`);
      const res = await fetch(url);
      if (!res.ok) { console.error(`❌ HTTP ${res.status}: ${url}`); continue; }
      const text = await res.text();
      console.log(`🧠 Parseando lista...`);
      const items = parseM3U(text);
      console.log(`📺 ${items.length} items encontrados`);
      allItems = allItems.concat(items);
      console.log(`📦 Total acumulado: ${allItems.length}`);
    } catch (err) {
      console.error(`❌ Error descargando ${url}:`, err.message);
    }
  }
  console.log(`🧩 Agrupando contenido...`);
  const grouped = groupContent(allItems);
  console.log(`✅ ${grouped.movies.length} películas`);
  console.log(`✅ ${Object.keys(grouped.series).length} series`);
  return grouped;
}

async function initData(config, configId) {
  console.log(`🔄 Cargando listas...`);
  globalData.ready = false;
  const { movies, series } = await loadList(config.m3uUrls);

  const movieGroupMap = {};
  const seriesGroupMap = {};
  for (const m of movies) {
    const g = m.genres?.[0];
    if (g) movieGroupMap[slugify(g)] = g;
  }
  for (const s of Object.values(series)) {
    const g = s.genres?.[0];
    if (g) seriesGroupMap[slugify(g)] = g;
  }

  globalData = {
    movies,
    series,
    tmdbCache:       {},
    movieImdbIndex:  {},
    seriesImdbIndex: {},
    apiKey:          config.tmdbApiKey || null,
    configId,
    ready:           true,
    movieGroupMap,
    seriesGroupMap
  };
  console.log(`✅ Datos cargados y listos`);
  prefetchTMDB(globalData).catch(err =>
    console.error("❌ Error en pre-carga TMDB:", err)
  );
}

const LOGO_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'>
  <defs>
    <linearGradient id='bg' x1='0%' y1='0%' x2='100%' y2='100%'>
      <stop offset='0%' stop-color='#1a1a2e'/><stop offset='100%' stop-color='#0f3460'/>
    </linearGradient>
    <linearGradient id='txt' x1='0%' y1='0%' x2='100%' y2='0%'>
      <stop offset='0%' stop-color='#00d4ff'/><stop offset='100%' stop-color='#0077ff'/>
    </linearGradient>
  </defs>
  <rect width='256' height='256' rx='48' fill='url(#bg)'/>
  <rect x='20' y='20' width='216' height='216' rx='36' fill='none' stroke='#00d4ff' stroke-width='3' stroke-opacity='0.3'/>
  <text x='128' y='168' font-family='Arial Black,sans-serif' font-size='96' font-weight='900' text-anchor='middle' fill='url(#txt)'>M3U</text>
</svg>`;

const LOGO = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;

const STREMIO_SIGNATURE =
  "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..drO4si40GNH5_7aW8jgB9g.-1ysZnzhUaDVuZwvH2qcKs-pGPZ5D1ikiZQG1OfrWSNLrdVAU4wiuI1zXj2LtWNyn-ckw9K3be7ufwYrfXra0ty2W72J5wibK6spyF0n20oc925LpgsA2yhZvfYpGWeh.1RFI7MSVY2fm6IKI7dOqyw";

app.get("/", (req, res) => res.redirect("/configure"));

app.get("/configure", (req, res) => {
  res.sendFile(path.join(__dirname, "configure.html"));
});

app.post("/api/config", async (req, res) => {
  const { m3uUrls, tmdbApiKey } = req.body;
  if (!Array.isArray(m3uUrls) || !m3uUrls.length) {
    return res.status(400).json({ error: "m3uUrls required" });
  }
  const config = { m3uUrls };
  if (tmdbApiKey) config.tmdbApiKey = tmdbApiKey;
  const id = saveConfig(config);
  if (id !== globalData.configId) {
    initData(config, id).catch(err =>
      console.error("❌ Error al recargar datos:", err)
    );
  }
  res.json({ id });
});

app.get("/manifest.json", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json({
    id:          "com.m3uiptv.public",
    version:     "1.1.4",
    name:        "M3U IPTV",
    description: "Stream your personal M3U playlist or Xtream Codes IPTV in Stremio. Auto-resolves IMDb IDs via TMDB. By Esmequiinn (reddit user Thin-Soil-4159)",
    logo:        "https://raw.githubusercontent.com/Esmequiinn/addon-m3u_friendly/main/logo.svg",
    resources:   ["catalog", "stream", "meta"],
    types:       ["movie", "series"],
    catalogs: [
      { type: "movie",  id: "m3u_movies", name: "My Movies",  extra: [{ name: "search", isRequired: false }] },
      { type: "series", id: "m3u_series", name: "My Series",  extra: [{ name: "search", isRequired: false }] }
    ],
    behaviorHints: {
      configurable:          true,
      configurationRequired: true,
      configureUrl:          `${baseUrl}/configure`
    },
    stremioAddonsConfig: {
      issuer:    "https://stremio-addons.net",
      signature: STREMIO_SIGNATURE
    }
  });
});

app.get("/:configId/manifest.json", (req, res) => {
  const config = getConfig(req.params.configId);
  if (!config) return res.status(404).json({ error: "Config not found. Please reconfigure the addon." });
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const catalogs = [
    {
      type: "movie", id: "m3u_movies", name: "Mis Películas",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
    },
    {
      type: "series", id: "m3u_series", name: "Mis Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
    }
  ];

  if (globalData.ready && globalData.configId === req.params.configId) {
    for (const [slug, name] of Object.entries(globalData.movieGroupMap || {})) {
      catalogs.push({
        type: "movie", id: `group_movie_${slug}`, name,
        extra: [{ name: "skip", isRequired: false }]
      });
    }
    for (const [slug, name] of Object.entries(globalData.seriesGroupMap || {})) {
      catalogs.push({
        type: "series", id: `group_series_${slug}`, name,
        extra: [{ name: "skip", isRequired: false }]
      });
    }
  }

  res.json({
    id:          "com.m3uiptv.public",
    version:     "1.1.4",
    name:        "M3U IPTV",
    description: "Reproduce tu lista M3U personal en Stremio con IDs IMDb automáticos. By Esmequiinn (reddit user Thin-Soil-4159)",
    logo:        LOGO,
    resources:   ["catalog", "stream", "meta"],
    types:       ["movie", "series"],
    catalogs,
    behaviorHints: { configurable: true, configureUrl: `${baseUrl}/configure` },
    stremioAddonsConfig: {
      issuer:    "https://stremio-addons.net",
      signature: STREMIO_SIGNATURE
    }
  });
});

app.get("/:configId/catalog/:type/:id.json",        handleCatalog);
app.get("/:configId/catalog/:type/:id/:extra.json", handleCatalog);

async function handleCatalog(req, res) {
  try {
    if (!getConfig(req.params.configId)) return res.json({ metas: [] });
    if (!globalData.ready)               return res.json({ metas: [] });
    const { type, id } = req.params;
    const extra  = req.params.extra
      ? Object.fromEntries(new URLSearchParams(req.params.extra))
      : {};
    const search = extra.search ? normalize(extra.search) : null;
    const skip   = parseInt(extra.skip || "0", 10);
    const PAGE   = 100;
    if (type === "movie" && id === "m3u_movies") {
      let results = globalData.movies;
      if (search) results = results.filter(m => normalize(m.title).includes(search));
      return res.json({
        metas: results.slice(skip, skip + PAGE).map(m => ({
          id: m.id, type: "movie", name: m.title, poster: m.poster
        }))
      });
    }
    if (type === "series" && id === "m3u_series") {
      let results = Object.values(globalData.series);
      if (search) results = results.filter(s => normalize(s.title).includes(search));
      return res.json({
        metas: results.slice(skip, skip + PAGE).map(s => ({
          id: s.id, type: "series", name: s.title, poster: s.poster
        }))
      });
    }
    if (type === "movie" && id.startsWith("group_movie_")) {
      const slug = id.slice("group_movie_".length);
      const groupName = globalData.movieGroupMap?.[slug];
      if (!groupName) return res.json({ metas: [] });
      let results = globalData.movies.filter(m => m.genres?.[0] === groupName);
      if (search) results = results.filter(m => normalize(m.title).includes(search));
      return res.json({
        metas: results.slice(skip, skip + PAGE).map(m => ({
          id: m.id, type: "movie", name: m.title, poster: m.poster
        }))
      });
    }
    if (type === "series" && id.startsWith("group_series_")) {
      const slug = id.slice("group_series_".length);
      const groupName = globalData.seriesGroupMap?.[slug];
      if (!groupName) return res.json({ metas: [] });
      let results = Object.values(globalData.series).filter(s => s.genres?.[0] === groupName);
      if (search) results = results.filter(s => normalize(s.title).includes(search));
      return res.json({
        metas: results.slice(skip, skip + PAGE).map(s => ({
          id: s.id, type: "series", name: s.title, poster: s.poster
        }))
      });
    }
    res.json({ metas: [] });
  } catch (err) {
    console.error("❌ Catalog error:", err);
    res.json({ metas: [] });
  }
}

app.get("/:configId/meta/:type/:id.json", async (req, res) => {
  try {
    if (!getConfig(req.params.configId)) return res.json({ meta: null });
    if (!globalData.ready)               return res.json({ meta: null });
    const { type, id } = req.params;
    const { movies, series, tmdbCache, movieImdbIndex, seriesImdbIndex, apiKey } = globalData;
    if (type === "movie") {
      const slugKey = movieImdbIndex[id] || id;
      let movie = movies.find(m => m.id === id || m.id === slugKey)
        || movies.find(m => normalize(m.title) === normalize(id));
      if (!movie) return res.json({ meta: null });
      if (!movie.id.startsWith("tt")) {
        const imdb = await searchTMDB(movie.title, "movie", tmdbCache, apiKey);
        if (imdb) { movieImdbIndex[imdb] = movie.id; movie.id = imdb; }
      }
      return res.json({
        meta: { id: movie.id, type: "movie", name: movie.title, poster: movie.poster }
      });
    }
    if (type === "series") {
      const slugKey = seriesImdbIndex[id] || id;
      let show = series[slugKey] || series[id]
        || Object.values(series).find(s => normalize(s.title) === normalize(id));
      if (!show) return res.json({ meta: null });
      if (!show.id.startsWith("tt")) {
        const imdb = await searchTMDB(show.title, "series", tmdbCache, apiKey);
        if (imdb) { seriesImdbIndex[imdb] = show.id; show.id = imdb; }
      }
      return res.json({
        meta: {
          id: show.id, type: "series", name: show.title, poster: show.poster,
          videos: show.episodes.map(ep => ({
            id:     `${show.id}:${ep.season}:${ep.episode}`,
            title:  ep.title,
            season: ep.season,
            number: ep.episode
          }))
        }
      });
    }
    res.json({ meta: null });
  } catch (err) {
    console.error("❌ Meta error:", err);
    res.json({ meta: null });
  }
});

app.get("/:configId/stream/:type/:id.json", async (req, res) => {
  try {
    if (!getConfig(req.params.configId)) return res.json({ streams: [] });
    if (!globalData.ready)               return res.json({ streams: [] });
    const { type, id } = req.params;
    const { movies, series, movieImdbIndex, seriesImdbIndex } = globalData;
    if (type === "movie") {
      const slugKey = movieImdbIndex[id] || id;
      const movie = movies.find(m => m.id === id || m.id === slugKey)
        || movies.find(m => normalize(m.title) === normalize(id));
      if (!movie) return res.json({ streams: [] });
      return res.json({
        streams: movie.streams.map((s, i) => ({
          url: s.url, name: "M3U", title: `Stream ${i + 1}`
        }))
      });
    }
    if (type === "series") {
      const parts   = id.split(":");
      const rawId   = parts[0];
      const season  = parseInt(parts[1], 10);
      const episode = parseInt(parts[2], 10);
      const slugKey = seriesImdbIndex[rawId] || rawId;
      const show = series[slugKey] || series[rawId]
        || Object.values(series).find(s =>
            normalize(s.title) === normalize(rawId) || s.id === rawId
          );
      if (!show) return res.json({ streams: [] });
      const eps = show.episodes.filter(
        e => e.season === season && e.episode === episode
      );
      return res.json({
        streams: eps.map((ep, i) => ({
          url: ep.url, name: "M3U", title: `Stream ${i + 1}`
        }))
      });
    }
    res.json({ streams: [] });
  } catch (err) {
    console.error("❌ Stream error:", err);
    res.json({ streams: [] });
  }
});

// ─────────────────────────────────────────────
// KEEP-ALIVE — ping cada 14 min para evitar que
// Render duerma el servicio en plan gratuito
// ─────────────────────────────────────────────

function startKeepAlive(baseUrl) {
  setInterval(async () => {
    try {
      await fetch(`${baseUrl}/manifest.json`);
      console.log(`💓 Keep-alive OK`);
    } catch (err) {
      console.error(`❌ Keep-alive error:`, err.message);
    }
  }, 14 * 60 * 1000);
}

app.listen(PORT, async () => {
  console.log(`🚀 M3U IPTV corriendo en http://localhost:${PORT}`);

  // Prioridad 1: variables de entorno de Render
  const envUrls = process.env.M3U_URLS
    ? process.env.M3U_URLS.split(",").map(u => u.trim()).filter(Boolean)
    : process.env.M3U_URL
      ? [process.env.M3U_URL.trim()]
      : [];

  if (envUrls.length) {
    const config = { m3uUrls: envUrls };
    if (process.env.TMDB_API_KEY) config.tmdbApiKey = process.env.TMDB_API_KEY;
    const id = saveConfig(config);
    await initData(config, id);

    const publicUrl = process.env.RENDER_EXTERNAL_URL;
    if (publicUrl) {
      console.log(`💓 Keep-alive iniciado: ${publicUrl}`);
      startKeepAlive(publicUrl);
    }
    return;
  }

  // Prioridad 2: última config guardada en disco (sobrevive reinicios)
  if (configStore.size > 0) {
    const [lastId, lastConfig] = [...configStore.entries()].pop();
    console.log(`🔁 Restaurando config guardada (${lastId})...`);
    await initData(lastConfig, lastId);

    const publicUrl = process.env.RENDER_EXTERNAL_URL;
    if (publicUrl) {
      console.log(`💓 Keep-alive iniciado: ${publicUrl}`);
      startKeepAlive(publicUrl);
    }
    return;
  }

  console.log("⚠️  Sin listas configuradas — configura desde /configure");

  // Iniciar keep-alive usando la URL pública de Render si está disponible
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    console.log(`💓 Keep-alive iniciado: ${publicUrl}`);
    startKeepAlive(publicUrl);
  }
});
