export default async function handler(req, res) {
  // CORS (para poder probar desde navegador/Hoppscotch sin Proxy si quieres)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido. Usa POST." });
  }

  // RequestId sin crypto (evita problemas ESM/CJS en Vercel)
  const requestId =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  const {
    zona,
    municipio_preferido,
    tamano_perro,
    quiere_playa,
    tipo_viaje,
    duracion_dias,
  } = req.body || {};

  if (!zona && !municipio_preferido) {
    return res.status(400).json({
      ok: false,
      requestId,
      error:
        "Falta la zona o el municipio. Envía al menos 'zona' (por ejemplo, 'maresme').",
    });
  }

  const baseId = process.env.AIRTABLE_BASE_ID;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !token) {
    return res.status(500).json({
      ok: false,
      requestId,
      error: "Faltan variables de entorno de Airtable en el servidor.",
    });
  }

  // IDs reales de cada tabla
  const TABLE_ALOJAMIENTOS = "tbl8l5yXMFMNE5v5e"; // alojamientos
  const TABLE_RESTAURANTES = "tblKeZSdLgvidj9Qj"; // restaurantes
  const TABLE_EXPERIENCIAS = "tblOaarE2MmWhMUef"; // experiencias
  const TABLE_PLAYAS = "tblbf2wiRYFMFLLZQ"; // playas_caninas

  const headers = { Authorization: `Bearer ${token}` };

  // Por defecto: si no se indica quiere_playa, asumimos que SÍ quiere playas
  const includePlayas = quiere_playa !== false;

  // Escape para filterByFormula
  const esc = (v) => String(v ?? "").replace(/'/g, "\\'");

  function buildFilterFormula() {
    const filtros = [];
    if (municipio_preferido) {
      filtros.push(`{municipio}='${esc(municipio_preferido)}'`);
    } else if (zona) {
      filtros.push(`{zona}='${esc(zona)}'`);
    }
    if (filtros.length === 0) return null;
    return filtros.length === 1 ? filtros[0] : `AND(${filtros.join(",")})`;
  }

  function normalizeStr(v) {
    return String(v || "").trim().toLowerCase();
  }

  // “mezcla” reproducible por request
  function seededRandom(seedStr) {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return function () {
      h += h << 13;
      h ^= h >>> 7;
      h += h << 3;
      h ^= h >>> 17;
      h += h << 5;
      return ((h >>> 0) % 10000) / 10000;
    };
  }

  function seededShuffle(arr, seedStr) {
    const rand = seededRandom(seedStr);
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function uniqById(arr) {
    const seen = new Set();
    const out = [];
    for (const item of arr || []) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  function matchesMunicipioOrZona(item, municipio, zona) {
    const m = normalizeStr(item.municipio);
    const z = normalizeStr(item.zona);
    const targetM = normalizeStr(municipio);
    const targetZ = normalizeStr(zona);

    if (targetM) return m === targetM;
    if (targetZ) return z === targetZ;
    return true;
  }

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Airtable paginación por offset.
   * - pageSize: hasta 100 (máximo Airtable)
   * - hardLimit: límite de seguridad (ajústalo si quieres)
   */
  async function fetchAllRecords(tableIdOrName, { hardLimit = 800 } = {}) {
    const formula = buildFilterFormula();

    let all = [];
    let offset = null;
    let loops = 0;

    while (true) {
      loops += 1;
      if (loops > 30) break; // seguridad extra

      const url = new URL(
        `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(
          tableIdOrName
        )}`
      );

      // Recomiendo crear una vista "api_public" sin filtros ni orden raro.
      // De momento mantenemos "Grid view" para no tocar Airtable.
      url.searchParams.set("view", "Grid view");
      url.searchParams.set("pageSize", "100");

      if (formula) url.searchParams.set("filterByFormula", formula);
      if (offset) url.searchParams.set("offset", offset);

      const attempt = async () => fetchWithTimeout(url.toString(), 10000);

      let resp;
      try {
        resp = await attempt();
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500));
        resp = await attempt();
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const err = new Error(
          `Error al consultar Airtable (${tableIdOrName}): ${resp.status} - ${text.slice(
            0,
            300
          )}`
        );
        err.status = resp.status;
        throw err;
      }

      const data = await resp.json();
      const batch = data.records || [];
      all.push(...batch);

      if (all.length >= hardLimit) {
        all = all.slice(0, hardLimit);
        break;
      }

      offset = data.offset;
      if (!offset) break;
    }

    return all;
  }

  function mapRecords(records) {
    return (records || []).map((r) => ({ id: r.id, ...r.fields }));
  }

  function pickSettled(result, key) {
    if (result.status === "fulfilled") {
      return { data: mapRecords(result.value), error: null };
    }
    return {
      data: [],
      error: {
        key,
        message: result.reason?.message || String(result.reason),
        status: result.reason?.status,
      },
    };
  }

  // Scores simples (puedes afinarlos cuando tengas tiempo)
  function scoreAloj(a) {
    let s = 0;
    if (a.ideal_para_familias === true) s += 3;
    if (normalizeStr(a.certificado_biosphere) === "si") s += 2;
    if (normalizeStr(a.accesible) === "si") s += 1;
    if (normalizeStr(a.admite_mas_de_una_mascota) === "si") s += 1;
    if (a.web) s += 1;
    if (a.maps_url) s += 1;
    return s;
  }

  function scoreRest(r) {
    let s = 0;
    if (normalizeStr(r.terraza) === "si") s += 2;
    if (r.web) s += 1;
    if (r.maps_url) s += 1;
    return s;
  }

  function scoreExp(e) {
    let s = 0;
    if (normalizeStr(e.certificado_biosphere) === "si") s += 2;
    if (e.web) s += 1;
    if (e.maps_url) s += 1;

    if (Array.isArray(e.tipo_experiencia)) {
      const t = e.tipo_experiencia.map(normalizeStr);
      if (
        t.includes("aire_libre") ||
        t.includes("senderismo") ||
        t.includes("naturaleza")
      )
        s += 1;
    }
    return s;
  }

  try {
    const tasks = {
      alojamientos: fetchAllRecords(TABLE_ALOJAMIENTOS, { hardLimit: 800 }),
      restaurantes: fetchAllRecords(TABLE_RESTAURANTES, { hardLimit: 800 }),
      experiencias: fetchAllRecords(TABLE_EXPERIENCIAS, { hardLimit: 1200 }),
      playas: includePlayas
        ? fetchAllRecords(TABLE_PLAYAS, { hardLimit: 400 })
        : Promise.resolve([]),
    };

    const keys = Object.keys(tasks);
    const settled = await Promise.allSettled(keys.map((k) => tasks[k]));

    const errors = {};
    const out = {};

    settled.forEach((resSettled, i) => {
      const key = keys[i];
      const { data, error } = pickSettled(resSettled, key);
      out[key] = data;
      if (error) errors[key] = error;
    });

    // ---------- ALOJAMIENTOS: filtrar + escoger 3 “mejores” con variación ----------
    let alojamientosAll = uniqById(out.alojamientos).filter((a) =>
      matchesMunicipioOrZona(a, municipio_preferido, zona)
    );

    if (tamano_perro) {
      alojamientosAll = alojamientosAll.filter(
        (a) =>
          Array.isArray(a.tamanos_admitidos) &&
          a.tamanos_admitidos.includes(tamano_perro)
      );
    }

    alojamientosAll.sort((a, b) => scoreAloj(b) - scoreAloj(a));
    const alojTop = alojamientosAll.slice(0, 12);
    const alojMix = seededShuffle(alojTop, requestId + "|aloj");
    const alojamientos = alojMix.slice(0, 3);

    // ---------- RESTAURANTES: filtrar + escoger 3 con variación ----------
    let restaurantesAll = uniqById(out.restaurantes).filter((r) =>
      matchesMunicipioOrZona(r, municipio_preferido, zona)
    );

    restaurantesAll.sort((a, b) => scoreRest(b) - scoreRest(a));
    const restTop = restaurantesAll.slice(0, 15);
    const restMix = seededShuffle(restTop, requestId + "|rest");
    const restaurantes = restMix.slice(0, 3);

    // ---------- EXPERIENCIAS: filtrar + escoger 6 con variación (para que entren rutas) ----------
    let experienciasAll = uniqById(out.experiencias).filter((e) =>
      matchesMunicipioOrZona(e, municipio_preferido, zona)
    );

    if (tipo_viaje === "familias" || tipo_viaje === "familias_naturaleza") {
      const fam = experienciasAll.filter(
        (e) => Array.isArray(e.ideal_para) && e.ideal_para.includes("familias")
      );
      if (fam.length) experienciasAll = fam; // si no hay, no filtramos para no quedarnos sin rutas
    }

    experienciasAll.sort((a, b) => scoreExp(b) - scoreExp(a));
    const expTop = experienciasAll.slice(0, 30);
    const expMix = seededShuffle(expTop, requestId + "|exp");
    const experiencias = expMix.slice(0, 6);

    // ---------- PLAYAS: filtrar + devolver hasta 9 (para variedad) ----------
    let playasAll = uniqById(out.playas).filter((p) =>
      matchesMunicipioOrZona(p, municipio_preferido, zona)
    );

    const playasMix = seededShuffle(playasAll, requestId + "|playa");
    const playas = playasMix.slice(0, 9);

    // Log útil para Vercel (no afecta al usuario)
    console.log(
      JSON.stringify({
        requestId,
        ok: Object.keys(errors).length === 0,
        errors: Object.keys(errors).length ? errors : null,
        counts_raw: {
          alojamientos: out.alojamientos.length,
          restaurantes: out.restaurantes.length,
          experiencias: out.experiencias.length,
          playas: out.playas.length,
        },
        counts_out: {
          alojamientos: alojamientos.length,
          restaurantes: restaurantes.length,
          experiencias: experiencias.length,
          playas: playas.length,
        },
      })
    );

    return res.status(200).json({
      ok: Object.keys(errors).length === 0,
      requestId,
      errors,
      zona: zona || null,
      municipio_preferido: municipio_preferido || null,
      tamano_perro: tamano_perro || null,
      duracion_dias: duracion_dias || null,
      tipo_viaje: tipo_viaje || null,
      alojamientos,
      restaurantes,
      experiencias,
      playas,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        requestId,
        error: err?.message || String(err),
        stack: err?.stack,
      })
    );

    return res.status(500).json({
      ok: false,
      requestId,
      error: "Error interno en plan-viaje",
      detalle: err?.message || String(err),
    });
  }
}
