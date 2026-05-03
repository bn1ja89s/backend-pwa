const TOKEN_URL = 'https://www.arcgis.com/sharing/rest/oauth2/token';

const LAYER_URLS = {
  proyectos: process.env.ARCGIS_PROJECT_LAYER_URL || process.env.ARCGIS_PROYECTO_LAYER_URL,
  collars: process.env.ARCGIS_COLLAR_LAYER_URL,
  surveys: process.env.ARCGIS_SURVEY_LAYER_URL,
  assays: process.env.ARCGIS_ASSAY_LAYER_URL,
};

const CLIENT_ID = process.env.ARCGIS_CLIENT_ID;
const CLIENT_SECRET = process.env.ARCGIS_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiresAt = 0;
const layerInfoCache = new Map();

function normalizeLayerUrl(layerUrl) {
  return String(layerUrl || '').replace(/\/+$/, '');
}

function validateFeatureLayerUrl(tabla, layerUrl) {
  const url = normalizeLayerUrl(layerUrl);
  if (!/\/FeatureServer\/\d+$/i.test(url)) {
    throw new Error(`[arcgis] ${tabla} ARCGIS layer URL invalida: ${layerUrl}. Debe apuntar a FeatureServer/<layerId>, no a MapServer ni al item general.`);
  }
  return url;
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

async function requestArcgis(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, { method: 'POST', body });
  return res.json();
}

async function postArcgis(url, params) {
  const data = await requestArcgis(url, params);
  if (data?.error) {
    throw new Error(`ArcGIS error en ${url}: ` + JSON.stringify(data.error));
  }
  return data;
}

async function getLayerInfo(layerUrl, token) {
  const url = normalizeLayerUrl(layerUrl);
  const cached = layerInfoCache.get(url);
  if (cached) return cached;

  const data = await postArcgis(url, {
    f: 'json',
    token,
  });

  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const fieldNames = new Set(fields.map((field) => field.name));
  const fieldNameByUpper = new Map(fields.map((field) => [String(field.name).toUpperCase(), field.name]));
  const info = {
    objectIdField: data.objectIdField || fieldNameByUpper.get('OBJECTID') || 'OBJECTID',
    globalIdField: data.globalIdField || fieldNameByUpper.get('GLOBALID') || 'GlobalID',
    fieldNames,
    fieldNameByUpper,
    relationships: Array.isArray(data?.relationships) ? data.relationships : [],
  };

  layerInfoCache.set(url, info);
  console.log(`[arcgis] campos disponibles en ${url}: ${Array.from(fieldNames).join(', ')}`);
  if (info.relationships.length) {
    console.log(`[arcgis] relaciones disponibles en ${url}: ${JSON.stringify(info.relationships)}`);
  }
  return info;
}

function hasField(layerInfo, fieldName) {
  return layerInfo.fieldNameByUpper.has(String(fieldName).toUpperCase());
}

function getActualFieldName(layerInfo, fieldName) {
  return layerInfo.fieldNameByUpper.get(String(fieldName).toUpperCase()) || fieldName;
}

function filterKnownAttributes(attributes, layerInfo, { keepObjectId = false } = {}) {
  const filtered = {};
  const ignored = [];

  for (const [fieldName, value] of Object.entries(attributes)) {
    const actualFieldName = getActualFieldName(layerInfo, fieldName);
    const isObjectId = actualFieldName === layerInfo.objectIdField;
    const isGlobalId = actualFieldName === layerInfo.globalIdField;

    if (!layerInfo.fieldNames.has(actualFieldName)) {
      ignored.push(fieldName);
      continue;
    }

    if ((isObjectId && !keepObjectId) || isGlobalId) {
      continue;
    }

    filtered[actualFieldName] = value === undefined ? null : value;
  }

  if (ignored.length) {
    console.warn(`[arcgis] atributos ignorados porque no existen en la capa: ${ignored.join(', ')}`);
  }

  return filtered;
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

function validateCollarAttributes(attributes, item) {
  const holeId = attributes.HOLE_ID || item?.id || 'sin HOLE_ID';
  if (!attributes.HOLE_ID) {
    throw new Error(`[arcgis] Collar ${holeId} omitido: HOLE_ID vacio o no mapeado.`);
  }

  for (const fieldName of ['ESTE', 'NORTE', 'ELEVACION', 'LATITUD', 'LONGITUD']) {
    if (attributes[fieldName] === undefined) {
      throw new Error(`[arcgis] Collar ${holeId} omitido: ${fieldName} quedo undefined.`);
    }
    if (attributes[fieldName] === null) {
      console.warn(`[arcgis] Collar ${holeId}: ${fieldName} se enviara como null.`);
    }
  }
}

function logPreparedFeature(feature) {
  console.log('Feature preparado para ArcGIS:', {
    hole_id: feature.attributes.HOLE_ID,
    attributes: feature.attributes,
    geometry: feature.geometry,
  });
}

function getLocalProjectReference(item) {
  const project = item?._project || item?.project || {};
  return {
    localUuid: pick(item, ['proyecto_uuid', 'proyectoUuid', 'project_uuid', 'projectUuid'])
      || pick(project, ['uuid', 'UUID', 'id']),
    remoteObjectId: pick(item, ['proyecto_remote_object_id', 'proyectoRemoteObjectId'])
      || pick(project, ['remote_object_id', 'remoteObjectId', 'OBJECTID', 'objectId']),
    globalId: pick(item, ['proyecto_global_id_remoto', 'proyectoGlobalIdRemoto', 'global_id_proyecto', 'PROYECTO_GUID'])
      || pick(project, ['global_id_remoto', 'GlobalID', 'GLOBALID']),
    codExploracion: pick(item, ['proyecto_codigo', 'proyectoCodigo', 'cod_exploracion', 'COD_EXPLORACION'])
      || pick(project, ['cod_exploracion', 'COD_EXPLORACION', 'codExploracion']),
    concesionArea: pick(item, ['proyecto_nombre', 'proyectoNombre', 'concesion_area', 'CONCESION_AREA'])
      || pick(project, ['concesion_area', 'CONCESION_AREA', 'concesionArea']),
    codCatastral: pick(item, ['cod_catastral', 'COD_CATASTRAL'])
      || pick(project, ['cod_catastral', 'COD_CATASTRAL', 'codCatastral']),
  };
}

function buildCollar(item, context = {}) {
  const lat = parseNumber(pick(item, ['latitud', 'LATITUD', 'latitude', 'LATITUDE', 'lat', 'LAT']));
  const lon = parseNumber(pick(item, ['longitud', 'LONGITUD', 'longitude', 'LONGITUDE', 'lng', 'LNG', 'lon', 'LON']));
  const este = parseNumber(pick(item, ['este', 'ESTE', 'easting', 'EASTING']));
  const norte = parseNumber(pick(item, ['norte', 'NORTE', 'northing', 'NORTHING']));
  const elevacion = parseNumber(pick(item, ['elevacion', 'ELEVACION', 'elevation', 'ELEVATION']));
  const collarGuid = pick(item, ['collar_guid', 'COLLAR_GUID', 'uuid', 'UUID', 'id_local', 'id']);
  const projectReference = getLocalProjectReference(item);

  validateLatitude(lat, item);
  validateLongitude(lon, item);

  const attributes = {
    COLLAR_GUID: collarGuid,
    GUID: collarGuid,
    PROYECTO_GUID: context.arcgisProjectGlobalId || projectReference.globalId,
    HOLE_ID: pick(item, ['hole_id', 'HOLE_ID', 'holeId']),
    ESTE: este,
    NORTE: norte,
    ELEVACION: elevacion,
    PROF_TOTAL: parseNumber(pick(item, ['prof_total', 'PROF_TOTAL', 'profTotal', 'profundidad_total', 'PROFUNDIDAD_TOTAL'])),
    PROFUNDIDAD_TOTAL: parseNumber(pick(item, ['profundidad_total', 'PROFUNDIDAD_TOTAL', 'prof_total', 'PROF_TOTAL', 'profTotal'])),
    TIPO: pick(item, ['tipo', 'TIPO']),
    LOCALIZACION: pick(item, ['localizacion', 'LOCALIZACION']),
    FECHA: normalizeDateValue(pick(item, ['fecha', 'FECHA'])),
    LATITUD: lat,
    LONGITUD: lon,
  };

  validateCollarAttributes(attributes, item);

  return {
    geometry: {
      x: lon,
      y: lat,
      spatialReference: { wkid: 4326 },
    },
    attributes,
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

async function queryObjectIds(layerUrl, token, layerInfo, where, label) {
  const data = await postArcgis(`${normalizeLayerUrl(layerUrl)}/query`, {
    f: 'json',
    token,
    where,
    outFields: layerInfo.objectIdField,
    returnGeometry: 'false',
    orderByFields: `${layerInfo.objectIdField} ASC`,
  });

  const features = Array.isArray(data?.features) ? data.features : [];
  const objectIds = features
    .map((feature) => parseObjectId(feature?.attributes?.[layerInfo.objectIdField] ?? feature?.attributes?.OBJECTID))
    .filter(Boolean);

  console.log(`[arcgis] query ${label}: ${objectIds.length} coincidencia(s).`);
  return objectIds;
}

async function queryFeatures(layerUrl, token, layerInfo, where, label, outFields = '*') {
  const data = await postArcgis(`${normalizeLayerUrl(layerUrl)}/query`, {
    f: 'json',
    token,
    where,
    outFields,
    returnGeometry: 'false',
    orderByFields: `${layerInfo.objectIdField} ASC`,
  });

  const features = Array.isArray(data?.features) ? data.features : [];
  console.log(`[arcgis] query ${label}: ${features.length} coincidencia(s).`);
  return features;
}

async function findExistingCollarObjectId(layerUrl, token, layerInfo, feature, item, { ignoreRemoteObjectId = false } = {}) {
  const remoteObjectId = parseObjectId(item.remote_object_id ?? item.remoteObjectId ?? item.OBJECTID ?? item.objectId);
  if (remoteObjectId && !ignoreRemoteObjectId) return remoteObjectId;

  const attributes = feature.attributes;
  const collarGuid = attributes.COLLAR_GUID || attributes.GUID || pick(item, ['collar_guid', 'COLLAR_GUID', 'uuid', 'UUID', 'id_local', 'id']);
  const holeId = attributes.HOLE_ID;
  const proyectoGuid = attributes.PROYECTO_GUID;

  const candidates = [];
  if (collarGuid && hasField(layerInfo, 'COLLAR_GUID')) {
    candidates.push({
      label: `COLLAR_GUID=${collarGuid}`,
      where: `${getActualFieldName(layerInfo, 'COLLAR_GUID')} = '${escapeWhereValue(collarGuid)}'`,
    });
  }
  if (collarGuid && hasField(layerInfo, 'GUID')) {
    candidates.push({
      label: `GUID=${collarGuid}`,
      where: `${getActualFieldName(layerInfo, 'GUID')} = '${escapeWhereValue(collarGuid)}'`,
    });
  }
  if (holeId && proyectoGuid && hasField(layerInfo, 'HOLE_ID') && hasField(layerInfo, 'PROYECTO_GUID')) {
    candidates.push({
      label: `HOLE_ID=${holeId} PROYECTO_GUID=${proyectoGuid}`,
      where: `${getActualFieldName(layerInfo, 'HOLE_ID')} = '${escapeWhereValue(holeId)}' AND ${getActualFieldName(layerInfo, 'PROYECTO_GUID')} = '${escapeWhereValue(proyectoGuid)}'`,
    });
  }
  if (holeId && hasField(layerInfo, 'HOLE_ID')) {
    candidates.push({
      label: `HOLE_ID=${holeId}`,
      where: `${getActualFieldName(layerInfo, 'HOLE_ID')} = '${escapeWhereValue(holeId)}'`,
    });
  }

  for (const candidate of candidates) {
    const objectIds = await queryObjectIds(layerUrl, token, layerInfo, candidate.where, candidate.label);
    if (objectIds.length === 1) return objectIds[0];
    if (objectIds.length > 1) {
      console.warn(`[arcgis] ${candidate.label} tiene duplicados (${objectIds.join(', ')}). Se actualizara OBJECTID ${objectIds[0]} y debes limpiar el resto.`);
      return objectIds[0];
    }
  }

  return null;
}

function buildProjectSearchCandidates(project, layerInfo) {
  const candidates = [];
  const remoteObjectId = parseObjectId(project.remote_object_id ?? project.remoteObjectId ?? project.OBJECTID ?? project.objectId);
  const remoteGlobalId = pick(project, ['global_id_remoto', 'globalIdRemoto', 'GlobalID', 'GLOBALID']);
  const codExploracion = pick(project, ['cod_exploracion', 'COD_EXPLORACION', 'codExploracion']);
  const concesionArea = pick(project, ['concesion_area', 'CONCESION_AREA', 'concesionArea']);
  const codCatastral = pick(project, ['cod_catastral', 'COD_CATASTRAL', 'codCatastral']);

  if (remoteObjectId) {
    candidates.push({
      label: `proyecto OBJECTID=${remoteObjectId}`,
      where: `${layerInfo.objectIdField} = ${remoteObjectId}`,
    });
  }
  if (remoteGlobalId) {
    candidates.push({
      label: `proyecto GlobalID=${remoteGlobalId}`,
      where: `${layerInfo.globalIdField} = '${escapeWhereValue(remoteGlobalId)}'`,
    });
  }
  if (codExploracion && hasField(layerInfo, 'COD_EXPLORACION')) {
    candidates.push({
      label: `proyecto COD_EXPLORACION=${codExploracion}`,
      where: `${getActualFieldName(layerInfo, 'COD_EXPLORACION')} = '${escapeWhereValue(codExploracion)}'`,
    });
  }
  if (codExploracion && concesionArea && hasField(layerInfo, 'COD_EXPLORACION') && hasField(layerInfo, 'CONCESION_AREA')) {
    candidates.push({
      label: `proyecto COD_EXPLORACION=${codExploracion} CONCESION_AREA=${concesionArea}`,
      where: `${getActualFieldName(layerInfo, 'COD_EXPLORACION')} = '${escapeWhereValue(codExploracion)}' AND ${getActualFieldName(layerInfo, 'CONCESION_AREA')} = '${escapeWhereValue(concesionArea)}'`,
    });
  }
  if (codCatastral && hasField(layerInfo, 'COD_CATASTRAL')) {
    candidates.push({
      label: `proyecto COD_CATASTRAL=${codCatastral}`,
      where: `${getActualFieldName(layerInfo, 'COD_CATASTRAL')} = '${escapeWhereValue(codCatastral)}'`,
    });
  }

  return candidates;
}

async function findExistingProject(layerUrl, token, layerInfo, project) {
  for (const candidate of buildProjectSearchCandidates(project, layerInfo)) {
    const features = await queryFeatures(layerUrl, token, layerInfo, candidate.where, candidate.label, `${layerInfo.objectIdField},${layerInfo.globalIdField},COD_EXPLORACION,CONCESION_AREA,COD_CATASTRAL`);
    if (features.length === 1) return features[0];
    if (features.length > 1) {
      console.warn(`[arcgis] ${candidate.label} tiene duplicados de proyecto; se usara el primer OBJECTID para no bloquear collars.`);
      return features[0];
    }
  }

  return null;
}

async function getProjectGlobalIdFromObjectId(layerUrl, token, layerInfo, objectId) {
  const features = await queryFeatures(
    layerUrl,
    token,
    layerInfo,
    `${layerInfo.objectIdField} = ${objectId}`,
    `proyecto creado OBJECTID=${objectId}`,
    `${layerInfo.objectIdField},${layerInfo.globalIdField}`,
  );
  return features[0]?.attributes?.[layerInfo.globalIdField] || null;
}

async function applyEdits(layerUrl, token, action, feature) {
  const params = {
    f: 'json',
    token,
    rollbackOnFailure: 'true',
  };

  if (action === 'update') {
    params.updates = JSON.stringify([feature]);
  } else {
    params.adds = JSON.stringify([feature]);
  }

  const response = await requestArcgis(`${normalizeLayerUrl(layerUrl)}/applyEdits`, params);
  console.log('Respuesta ArcGIS:', JSON.stringify(response, null, 2));

  if (response?.error) {
    throw new Error(`ArcGIS applyEdits ${action} error: ` + JSON.stringify(response));
  }

  const result = (response?.addResults || response?.updateResults || [])[0];
  if (!result?.success) {
    throw new Error(`ArcGIS applyEdits ${action} error: ` + JSON.stringify(response));
  }

  return result;
}

async function ensureArcgisProjectGlobalId(item, token) {
  const projectLayerUrl = LAYER_URLS.proyectos;
  if (!projectLayerUrl) {
    throw new Error('[arcgis] Falta ARCGIS_PROJECT_LAYER_URL o ARCGIS_PROYECTO_LAYER_URL para resolver PROYECTO.GlobalID antes de insertar collars.');
  }

  const layerUrl = validateFeatureLayerUrl('proyectos', projectLayerUrl);
  const layerInfo = await getLayerInfo(layerUrl, token);
  const project = item?._project || {};
  const projectReference = getLocalProjectReference(item);
  const projectForSearch = {
    ...project,
    remote_object_id: project.remote_object_id || projectReference.remoteObjectId,
    global_id_remoto: project.global_id_remoto || projectReference.globalId,
    cod_exploracion: project.cod_exploracion || projectReference.codExploracion,
    concesion_area: project.concesion_area || projectReference.concesionArea,
    cod_catastral: project.cod_catastral || projectReference.codCatastral,
  };

  const existingFeature = await findExistingProject(layerUrl, token, layerInfo, projectForSearch);
  if (existingFeature?.attributes?.[layerInfo.globalIdField]) {
    const arcgisProjectGlobalId = existingFeature.attributes[layerInfo.globalIdField];
    console.log('Proyecto ArcGIS encontrado:', {
      proyectoLocal: projectReference.localUuid || projectReference.codExploracion || projectReference.concesionArea,
      arcgisProjectGlobalId,
    });
    return arcgisProjectGlobalId;
  }

  if (!project || !Object.keys(project).length) {
    throw new Error(`No existe proyecto en ArcGIS para el collar ${pick(item, ['hole_id', 'HOLE_ID', 'holeId'])}. No se puede insertar collar sin PROYECTO.GlobalID valido.`);
  }

  const feature = buildProyecto(projectForSearch);
  feature.attributes = filterKnownAttributes(feature.attributes, layerInfo);
  console.log('[arcgis] Proyecto no existe; se creara antes del collar:', {
    proyectoLocal: projectReference.localUuid || projectReference.codExploracion || projectReference.concesionArea,
    attributes: feature.attributes,
  });

  const result = await applyEdits(layerUrl, token, 'add', feature);
  const arcgisProjectGlobalId = result.globalId || await getProjectGlobalIdFromObjectId(layerUrl, token, layerInfo, result.objectId);
  if (!arcgisProjectGlobalId) {
    throw new Error(`ArcGIS creo el proyecto para ${pick(item, ['hole_id', 'HOLE_ID', 'holeId'])}, pero no devolvio GlobalID; no se puede insertar el collar.`);
  }

  console.log('Proyecto ArcGIS encontrado:', {
    proyectoLocal: projectReference.localUuid || projectReference.codExploracion || projectReference.concesionArea,
    arcgisProjectGlobalId,
  });
  return arcgisProjectGlobalId;
}

function logPreparedCollarFeature(feature) {
  console.log('Feature collar preparado:', {
    hole_id: feature.attributes.HOLE_ID,
    proyecto_guid_enviado: feature.attributes.PROYECTO_GUID,
    geometry: feature.geometry,
  });
}

async function pushFeature(tabla, item) {
  const rawLayerUrl = LAYER_URLS[tabla];
  const builder = BUILDERS[tabla];
  if (!rawLayerUrl || !builder) return null;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn(`[arcgis] credenciales no configuradas, se omite ${tabla}`);
    return null;
  }

  const layerUrl = validateFeatureLayerUrl(tabla, rawLayerUrl);
  const token = await getToken();
  const layerInfo = await getLayerInfo(layerUrl, token);
  const context = {};

  if (tabla === 'collars') {
    context.arcgisProjectGlobalId = await ensureArcgisProjectGlobalId(item, token);
  }

  const feature = builder(item, context);

  let objectId = null;
  let existingGlobalId = null;
  if (tabla === 'collars') {
    objectId = await findExistingCollarObjectId(layerUrl, token, layerInfo, feature, item);
  } else if (tabla === 'proyectos') {
    const existingProject = await findExistingProject(layerUrl, token, layerInfo, item);
    existingGlobalId = existingProject?.attributes?.[layerInfo.globalIdField] || null;
    objectId = parseObjectId(existingProject?.attributes?.[layerInfo.objectIdField])
      || parseObjectId(item.remote_object_id ?? item.remoteObjectId ?? item.OBJECTID ?? item.objectId);
  } else {
    objectId = parseObjectId(item.remote_object_id ?? item.remoteObjectId ?? item.OBJECTID ?? item.objectId);
  }

  const action = objectId ? 'update' : 'add';
  const keepObjectId = action === 'update';
  feature.attributes = filterKnownAttributes(feature.attributes, layerInfo, { keepObjectId });

  if (objectId) {
    feature.attributes[layerInfo.objectIdField] = objectId;
  }

  if (tabla === 'collars') {
    logPreparedCollarFeature(feature);
    logPreparedFeature(feature);
  }

  let result;
  try {
    result = await applyEdits(layerUrl, token, action, feature);
  } catch (err) {
    if (tabla !== 'collars' || action !== 'update') throw err;

    console.warn(`[arcgis] update de collar fallo; se reintentara buscando por GUID/HOLE_ID antes de insertar. Error: ${err.message}`);
    const retryObjectId = await findExistingCollarObjectId(layerUrl, token, layerInfo, feature, item, { ignoreRemoteObjectId: true });
    if (retryObjectId && retryObjectId !== objectId) {
      feature.attributes[layerInfo.objectIdField] = retryObjectId;
      result = await applyEdits(layerUrl, token, 'update', feature);
    } else if (!retryObjectId) {
      delete feature.attributes[layerInfo.objectIdField];
      result = await applyEdits(layerUrl, token, 'add', feature);
    } else {
      throw err;
    }
  }

  return { objectId: result.objectId ?? objectId, globalId: result.globalId ?? existingGlobalId ?? null };
}

module.exports = { pushFeature };
