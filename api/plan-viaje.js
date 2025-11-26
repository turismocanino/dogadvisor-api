// api/plan-viaje.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido. Usa POST." });
    return;
  }

  const {
    zona,
    municipio_preferido,
    tamano_perro,
    quiere_playa,
    tipo_viaje,
    duracion_dias,
  } = req.body || {};

  if (!zona && !municipio_preferido) {
    res.status(400).json({
      error:
        "Falta la zona o el municipio. Envía al menos 'zona' (por ejemplo, 'maresme').",
    });
    return;
  }

  const baseId = process.env.AIRTABLE_BASE_ID;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !token) {
    res
      .status(500)
      .json({ error: "Faltan variables de entorno de Airtable en el servidor." });
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
  };

  async function fetchTable(tableName) {
    const url = new URL(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`
    );

    const filtros = [];

    if (municipio_preferido) {
      filtros.push(`{municipio}='${municipio_preferido}'`);
    } else if (zona) {
      filtros.push(`{zona}='${zona}'`);
    }

    if (filtros.length > 0) {
      const formula =
        filtros.length === 1 ? filtros[0] : `AND(${filtros.join(",")})`;
      url.searchParams.set("filterByFormula", formula);
    }

    url.searchParams.set("maxRecords", "20");

    const resp = await fetch(url.toString(), { headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Error al consultar Airtable (${tableName}): ${resp.status} - ${text}`
      );
    }
    const data = await resp.json();
    return data.records || [];
  }

  function mapRecords(records) {
    return records.map((r) => ({
      id: r.id,
      ...r.fields,
    }));
  }

  try {
    const [
      alojamientosRaw,
      restaurantesRaw,
      experienciasRaw,
      playasRaw,
    ] = await Promise.all([
      fetchTable("Alojamientos"),
      fetchTable("Restaurantes"),
      fetchTable("Experiencias"),
      quiere_playa ? fetchTable("Playas caninas") : Promise.resolve([]),
    ]);

    let alojamientos = mapRecords(alojamientosRaw);
    if (tamano_perro) {
      alojamientos = alojamientos.filter(
        (a) =>
          Array.isArray(a.tamanos_admitidos) &&
          a.tamanos_admitidos.includes(tamano_perro)
      );
    }
    alojamientos = alojamientos.slice(0, 3);

    let restaurantes = mapRecords(restaurantesRaw).slice(0, 3);

    let experiencias = mapRecords(experienciasRaw);
    if (tipo_viaje === "familias" || tipo_viaje === "familias_naturaleza") {
      experiencias = experiencias.filter(
        (e) =>
          Array.isArray(e.ideal_para) && e.ideal_para.includes("familias")
      );
    }
    experiencias = experiencias.slice(0, 3);

    let playas = mapRecords(playasRaw).slice(0, 2);

    res.status(200).json({
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
    console.error(err);
    res.status(500).json({
      error: "Error al consultar Airtable",
      detalle: err.message,
    });
  }
}
