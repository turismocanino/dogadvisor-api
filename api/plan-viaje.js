const { randomBytes } = require("crypto");

export default async function handler(req, res) {
  // (Opcional) CORS para poder probar desde navegador/Hoppscotch sin Proxy
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido. Usa POST." });
  }

  const requestId = randomBytes(8).toString("hex");

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
      error:
        "Falta la zona o el municipio. Envía al menos 'zona' (por ejemplo, 'maresme').",
      requestId,
    });
  }

  const baseId = process.env.AIRTABLE_BASE_ID;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !token) {
    return res.status(500).json({
      error: "Faltan variables de entorno de Airtable en el servidor.",
      requestId,
    });
  }

  // IDs reales de cada tabla
  const TABLE_ALOJAMIENTOS = "tbl8l5yXMFMNE5v5e";
  const TABLE_RESTAURANTES = "tblKeZSdLgvidj9Qj";
  const TABLE_EXPERIENCIAS = "tblOaarE2MmWhMUef";
  const TABLE_PLAYAS = "tblbf2wiRYFMFLLZQ";

  const headers = { Authorization: `Bearer ${token}` };

  // Por defecto: si no se indica quiere_playa, asumimos que SÍ quiere playas
  const includePlayas = quiere_playa !== false;

  const esc = (v) => String(v).replace(/'/g, "\\'");

  function buildFilterFormula() {
    const filtros = [];
    if (municipio_preferido) {
      filtros

