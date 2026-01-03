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
  const esc = (v) => String(v).replace(/'/g, "\\'");

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

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchTable(tableIdOrName) {
    const url = new URL(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableIdOrName)}`
    );

    // Recomendación: crea una vista estable (por ejemplo "api_public") y usa esa.
    // De momento lo dejo en "Grid view" para no tocar tu Airtable.
    url.searchParams.set("view", "Grid view");
    url.searchParams.set("maxRecords", "20");

    const formula = buildFilterFormula();
    if (formula) url.searchParams.set("filterByFormula", formula);

    const attempt = async () => fetchWithTimeout(url.toString(), 8000);

    // 1 intento + 1 reintento corto para abort/timeout
    let resp;
    try {
      resp = await attempt();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 400));
      resp = await attempt();
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const err = new Error(
        `Error al consultar Airtable (${tableIdOrName}): ${resp.status} - ${text.slice(0, 300)}`
      );
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    return data.records || [];
  }

  function mapRecords(records) {
    return records.map((r) => ({ id: r.id, ...r.fields }));
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

  try {
    const tasks = {
      alojamientos: fetchTable(TABLE_ALOJAMIENTOS),
      restaurantes: fetchTable(TABLE_RESTAURANTES),
      experiencias: fetchTable(TABLE_EXPERIENCIAS),
      playas: includePlayas ? fetchTable(TABLE_PLAYAS) : Promise.resolve([]),
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

    // Post-procesado (igual que tu lógica original)
    let alojamientos = out.alojamientos;
    if (tamano_perro) {
      alojamientos = alojamientos.filter(
        (a) =>
          Array.isArray(a.tamanos_admitidos) &&
          a.tamanos_admitidos.includes(tamano_perro)
      );
    }
    alojamientos = alojamientos.slice(0, 3);

    const restaurantes = out.restaurantes.slice(0, 3);

    let experiencias = out.experiencias;
    if (tipo_viaje === "familias" || tipo_viaje === "familias_naturaleza") {
      experiencias = experiencias.filter(
        (e) => Array.isArray(e.ideal_para) && e.ideal_para.includes("familias")
      );
    }
    experiencias = experiencias.slice(0, 3);

    const playas = out.playas.slice(0, 2);

    // Log útil para Vercel
    console.log(
      JSON.stringify({
        requestId,
        ok: Object.keys(errors).length === 0,
        errors: Object.keys(errors).length ? errors : null,
        counts: {
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
