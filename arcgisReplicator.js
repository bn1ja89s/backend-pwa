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

function normalizeLayerUrl(layerUrl) {
  return String(layerUrl || '').replace(/\/+$/, '');
}

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

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  let normalized = raw.replace(/\s+/g, '');
  const commaIndex = normalized.lastIndexOf(',');
  const dotIndex = normalized.lastIndexOf('.');

  if (commaIndex !== -1 && dotIndex !== -1) {
    const decimalSeparator = commaIndex > dotIndex ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = normalized
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.');
  } else if (commaIndex !== -1) {
    normalized = normalized.replace(',', '.');
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function num(value) {
  return parseNumber(value);
}

function parseObjectId(value) {
  const objectId = parseNumber(value);
  return Number.isInteger(objectId) && objectId > 0 ? objectId : null;
}

function pick(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function escapeWhereValue(value) {
  return String(value).replace(/'/g, "''");
}

async function postArcgis(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, { method: 'POST', body });
  return res.json();
}

async function queryObjectId(layerUrl, token, where, label) {
  const data = await postArcgis(`${normalizeLayerUrl(layerUrl)}/query`, {
    f: 'json',
    token,
    where,
    outFields: 'OBJECTID',
    returnGeometry: 'false',
    resultRecordCount: '2',
  });

  if (data?.error) {
    throw new Error(`ArcGIS query ${label} error: ` + JSON.stringify(data.error));
  }

  const features = Array.isArray(data?.features) ? data.features : [];
  if (features.length > 1) {
    throw new Error(`ArcGIS query ${label} encontro ${features.length} coincidencias; no se actualiza para evitar duplicados.`);
  }

  return parseObjectId(features[0]?.attributes?.OBJECTID);
}

async function findExistingCollarObjectId(layerUrl, token, feature, item) {
  const globalId = pick(item, ['global_id_remoto', 'globalIdRemoto', 'globalId', 'GLOBALID', 'GlobalID']);
  const holeId = feature.attributes.HOLE_ID;
  const proyectoGuid = feature.attributes.PROYECTO_GUID;

  if (globalId) {
    const objectId = await queryObjectId(
      layerUrl,
      token,
      `GlobalID = '${escapeWhereValue(globalId)}'`,
      `collar GlobalID=${globalId}`,
    );
    if (objectId) return objectId;
  }

  if (holeId && proyectoGuid) {
    const objectId = await queryObjectId(
      layerUrl,
      token,
      `HOLE_ID = '${escapeWhereValue(holeId)}' AND PROYECTO_GUID = '${escapeWhereValue(proyectoGuid)}'`,
      `collar HOLE_ID=${holeId} PROYECTO_GUID=${proyectoGuid}`,
    );
    if (objectId) return objectId;
  }

  if (holeId) {
    return queryObjectId(
      layerUrl,
      token,
      `HOLE_ID = '${escapeWhereValue(holeId)}'`,
      `collar HOLE_ID=${holeId}`,
    );
  }

  return null;
}

function validateLatitude(lat, item) {
  if (lat === null || lat < -90 || lat > 90) {
    const holeId = pick(item, ['hole_id', 'HOLE_ID', 'holeId']) || item?.id || 'sin HOLE_ID';
    throw new Error(`[arcgis] Collar ${holeId} omitido: latitud vacia o invalida (${pick(item, ['latitud', 'LATITUD', 'latitude', 'LATITUDE', 'lat', 'LAT'])}). Debe estar entre -90 y 90.`);
  }
}

function validateLongitude(lon, item) {
  if (lon === null || lon < -180 || lon > 180) {
    const holeId = pick(item, ['hole_id', 'HOLE_ID', 'holeId']) || item?.id || 'sin HOLE_ID';
    throw new Error(`[arcgis] Collar ${holeId} omitido: longitud vacia o invalida (${pick(item, ['longitud', 'LONGITUD', 'longitude', 'LONGITUDE', 'lng', 'LNG', 'lon', 'LON'])}). Debe estar entre -180 y 180.`);
  }
}

function logCollarFeature(feature, lat, lon) {
  console.log('Enviando collar a ArcGIS', {
    hole_id: feature.attributes.HOLE_ID,
    lat,
    lon,
    geometry: feature.geometry,
  });
}

function normalizeDateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return fechaEpoch(value);
}

function fechaEpoch(value) {
  if (!value) return null;
  const parsedNumber = parseNumber(value);
  if (parsedNumber !== null && String(value).trim().match(/^\d+([.,]\d+)?$/)) {
    return parsedNumber;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function buildCollar(item) {
  const lat = parseNumber(pick(item, ['latitud', 'LATITUD', 'latitude', 'LATITUDE', 'lat', 'LAT']));
  const lon = parseNumber(pick(item, ['longitud', 'LONGITUD', 'longitude', 'LONGITUDE', 'lng', 'LNG', 'lon', 'LON']));
  const este = parseNumber(pick(item, ['este', 'ESTE', 'easting', 'EASTING']));
  const norte = parseNumber(pick(item, ['norte', 'NORTE', 'northing', 'NORTHING']));
  const elevacion = parseNumber(pick(item, ['elevacion', 'ELEVACION', 'elevation', 'ELEVATION']));

  validateLatitude(lat, item);
  validateLongitude(lon, item);

  return {
    geometry: {
      x: lon,
      y: lat,
      spatialReference: { wkid: 4326 },
    },
    attributes: {
      PROYECTO_GUID: pick(item, ['proyecto_guid', 'PROYECTO_GUID', 'proyecto_global_id_remoto', 'proyectoGlobalIdRemoto', 'global_id_proyecto', 'proyecto_uuid', 'proyectoUuid']),
      HOLE_ID: pick(item, ['hole_id', 'HOLE_ID', 'holeId']),
      ESTE: este,
      NORTE: norte,
      ELEVACION: elevacion,
      PROF_TOTAL: parseNumber(pick(item, ['prof_total', 'PROF_TOTAL', 'profTotal', 'profundidad_total', 'PROFUNDIDAD_TOTAL'])),
      TIPO: pick(item, ['tipo', 'TIPO']),
      LOCALIZACION: pick(item, ['localizacion', 'LOCALIZACION']),
      FECHA: normalizeDateValue(pick(item, ['fecha', 'FECHA'])),
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

  let objectId = parseObjectId(item.remote_object_id ?? item.remoteObjectId ?? item.OBJECTID ?? item.objectId);

  if (!objectId && tabla === 'collars') {
    objectId = await findExistingCollarObjectId(layerUrl, token, feature, item);
    if (objectId) {
      console.log(`[arcgis] collar ${feature.attributes.HOLE_ID || item.id} ya existe en ArcGIS (OBJECTID=${objectId}); se actualizara geometry/attributes.`);
    }
  }

  const action = objectId ? 'updateFeatures' : 'addFeatures';

  if (action === 'updateFeatures') {
    feature.attributes.OBJECTID = objectId;
  }

  if (tabla === 'collars') {
    logCollarFeature(feature, feature.attributes.LATITUD, feature.attributes.LONGITUD);
  }

  const body = new URLSearchParams({
    f: 'json',
    token,
    features: JSON.stringify([feature]),
  });

  const res = await fetch(`${normalizeLayerUrl(layerUrl)}/${action}`, { method: 'POST', body });
  const data = await res.json();
  const result = (data?.addResults || data?.updateResults || [])[0];

  if (!result?.success) {
    throw new Error(`ArcGIS ${action} error: ` + JSON.stringify(data));
  }
  return { objectId: result.objectId ?? objectId, globalId: result.globalId ?? null };
}

module.exports = { pushFeature };
