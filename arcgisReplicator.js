const TOKEN_URL = 'https://www.arcgis.com/sharing/rest/oauth2/token';

const LAYER_URLS = {
  proyectos: process.env.ARCGIS_PROYECTO_LAYER_URL,
  collars: process.env.ARCGIS_COLLAR_LAYER_URL,
  surveys: process.env.ARCGIS_SURVEY_LAYER_URL,
  assays: process.env.ARCGIS_ASSAY_LAYER_URL,
};

const CLIENT_ID = process.env.ARCGIS_CLIENT_ID;
const CLIENT_SECRET = process.env.ARCGIS_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Faltan ARCGIS_CLIENT_ID o ARCGIS_CLIENT_SECRET');
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
    expiration: '1440',
  });

  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Error de token ArcGIS: ' + JSON.stringify(data));
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
  return cachedToken;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fechaEpoch(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function buildCollar(item) {
  const lat = num(item.latitud ?? item.latitude ?? item.lat);
  const lon = num(item.longitud ?? item.longitude ?? item.lng ?? item.lon);
  return {
    geometry: lat !== null && lon !== null
      ? { x: lon, y: lat, spatialReference: { wkid: 4326 } }
      : null,
    attributes: {
      PROYECTO_GUID: item.proyecto_uuid ?? item.proyectoUuid ?? item.proyecto_guid ?? null,
      HOLE_ID: item.hole_id ?? item.holeId ?? null,
      ESTE: num(item.este),
      NORTE: num(item.norte),
      ELEVACION: num(item.elevacion),
      PROF_TOTAL: num(item.prof_total ?? item.profTotal),
      TIPO: item.tipo ?? null,
      LOCALIZACION: item.localizacion ?? null,
      FECHA: fechaEpoch(item.fecha),
      LATITUD: lat,
      LONGITUD: lon,
    },
  };
}

function buildProyecto(item) {
  return {
    attributes: {
      COD_EXPLORACION: item.cod_exploracion ?? item.codExploracion ?? null,
      CONCESION_AREA: item.concesion_area ?? item.concesionArea ?? null,
      COD_CATASTRAL: item.cod_catastral ?? item.codCatastral ?? null,
      LOCALIZACION: item.localizacion ?? null,
      TECNICO: item.tecnico ?? null,
      SR_PROYECTO: item.sr_proyecto ?? item.srProyecto ?? null,
    },
  };
}

function buildSurvey(item) {
  return {
    attributes: {
      COLLAR_GUID: item.collar_uuid ?? item.collarUuid ?? null,
      HOLE_ID: item.hole_id ?? item.holeId ?? null,
      PROFUNDIDAD: num(item.profundidad),
      DIP: num(item.dip),
      AZIMUT: num(item.azimut),
      INSTRUMENTO: item.instrumento ?? null,
    },
  };
}

function buildAssay(item) {
  return {
    attributes: {
      COLLAR_GUID: item.collar_uuid ?? item.collarUuid ?? null,
      HOLE_ID: item.hole_id ?? item.holeId ?? null,
      DESDE: num(item.desde),
      HASTA: num(item.hasta),
      MATERIAL: item.material ?? null,
      DESCRIPCION: item.descripcion ?? null,
      CATEGORIA: item.categoria ?? null,
      COLOR: item.color ?? null,
      GRANO: item.grano ?? null,
      DUREZA: item.dureza ?? null,
      HUMEDAD: item.humedad ?? null,
      PRESENCIA_CAOLINITICA: item.presencia_caolinitica ?? item.presenciaCaolinitica ?? null,
      CONTAMINANTES: item.contaminantes ?? null,
      MUESTRA_ID: item.muestra_id ?? item.muestraId ?? null,
    },
  };
}

const BUILDERS = {
  proyectos: buildProyecto,
  collars: buildCollar,
  surveys: buildSurvey,
  assays: buildAssay,
};

async function pushFeature(tabla, item) {
  const layerUrl = LAYER_URLS[tabla];
  const builder = BUILDERS[tabla];
  if (!layerUrl || !builder) return null;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn(`[arcgis] credenciales no configuradas, se omite ${tabla}`);
    return null;
  }

  const token = await getToken();
  const feature = builder(item);

  const objectId = item.remote_object_id ?? item.remoteObjectId ?? null;
  const action = objectId ? 'updateFeatures' : 'addFeatures';

  if (action === 'updateFeatures') {
    feature.attributes.OBJECTID = objectId;
  }

  const body = new URLSearchParams({
    f: 'json',
    token,
    features: JSON.stringify([feature]),
  });

  const res = await fetch(`${layerUrl}/${action}`, { method: 'POST', body });
  const data = await res.json();
  const result = (data?.addResults || data?.updateResults || [])[0];

  if (!result?.success) {
    throw new Error(`ArcGIS ${action} error: ` + JSON.stringify(data));
  }
  return { objectId: result.objectId ?? objectId, globalId: result.globalId ?? null };
}

module.exports = { pushFeature };
