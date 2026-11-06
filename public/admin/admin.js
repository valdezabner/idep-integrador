'use strict';
/* ============================================================
   IDE Nacional · IDEP — Admin Panel
   Vanilla JS application logic (no frameworks)
   ============================================================ */

const API = '/api/v1';
let token = localStorage.getItem('ide_token');
let refreshToken = localStorage.getItem('ide_refresh_token');
let currentUser = null;

/* Registrar-assistant context (kept while switching between steps) */
let regCtx = null; // { tipo, id, recurso }

/* Simple in-memory caches used across renders */
let cacheEntidades = null;
let cacheEstilos = null;

/* ============================================================
   GENERIC HELPERS
   ============================================================ */

function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/** HTML-escape a value before inserting it into innerHTML. */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d.getTime())) return esc(str);
  return d.toLocaleString('es-PE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateOnly(str) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d.getTime())) return esc(str);
  return d.toLocaleDateString('es-PE', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = num;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Normalize list-shaped API responses: array, {data:[...]}, {rows:[...]}. */
function normList(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.data)) return res.data;
  if (res && Array.isArray(res.rows)) return res.rows;
  return [];
}

/** Normalize single-object-shaped API responses: object, {data:{...}}. */
function normObj(res) {
  if (res && typeof res === 'object' && !Array.isArray(res) && res.data && typeof res.data === 'object' && !Array.isArray(res.data)) {
    return res.data;
  }
  return res;
}

let alertTimer = null;
function showAlert(msg, type) {
  type = type || 'info';
  const box = qs('#global-alert');
  if (!box) { window.alert(msg); return; }
  const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '⛔' };
  box.className = `alert alert-${type}`;
  box.innerHTML = `<span class="alert-icon" aria-hidden="true">${icons[type] || icons.info}</span><span class="alert-body">${esc(msg)}</span>`;
  box.classList.remove('hidden');
  qs('#main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  if (alertTimer) clearTimeout(alertTimer);
  if (type !== 'error') {
    alertTimer = setTimeout(() => box.classList.add('hidden'), 6000);
  }
}

function showLoginAlert(msg) {
  const box = qs('#login-alert');
  if (!box) return;
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  box.textContent = msg;
  box.classList.remove('hidden');
}

/* ============================================================
   API WRAPPERS
   ============================================================ */

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (netErr) {
    throw new Error('No se pudo conectar con el servidor. Verifique su conexión.');
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = text; }
  }

  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') {
      handleSessionExpired();
    }
    const msg = (payload && typeof payload === 'object' && (payload.error || payload.message))
      || `Error ${res.status} al comunicarse con el servidor`;
    throw new Error(msg);
  }

  return payload;
}

async function apiForm(path, formData, method) {
  method = method || 'POST';
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API + path, { method, headers, body: formData });
  } catch (netErr) {
    throw new Error('No se pudo conectar con el servidor. Verifique su conexión.');
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = text; }
  }

  if (!res.ok) {
    if (res.status === 401) handleSessionExpired();
    const msg = (payload && typeof payload === 'object' && (payload.error || payload.message))
      || `Error ${res.status} al comunicarse con el servidor`;
    throw new Error(msg);
  }
  return payload;
}

let sessionExpiredHandled = false;
function handleSessionExpired() {
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  showAlert('Su sesión ha expirado. Vuelva a iniciar sesión.', 'error');
  setTimeout(() => { logout(true); }, 1200);
}

/* ============================================================
   MODAL
   ============================================================ */

function openModal(title, bodyHtml, footerHtml) {
  qs('#modal-title').innerHTML = title;
  qs('#modal-body').innerHTML = bodyHtml;
  const footer = qs('#modal-footer');
  if (footerHtml) {
    footer.innerHTML = footerHtml;
    footer.classList.remove('hidden');
  } else {
    footer.innerHTML = '';
    footer.classList.add('hidden');
  }
  const overlay = qs('#modal-overlay');
  overlay.classList.remove('hidden');
  overlay.classList.add('active');
  overlay.focus();
}

function closeModal() {
  const overlay = qs('#modal-overlay');
  overlay.classList.remove('active');
  overlay.classList.add('hidden');
  qs('#modal-body').innerHTML = '';
  qs('#modal-footer').innerHTML = '';
}

/* ============================================================
   AUTH
   ============================================================ */

async function login(email, password) {
  showLoginAlert('');
  const btn = qs('#login-btn');
  btn.disabled = true;
  btn.textContent = 'Ingresando…';
  try {
    const res = await api('POST', '/auth/login', { email, password });
    token = res.token;
    refreshToken = res.refreshToken;
    localStorage.setItem('ide_token', token);
    if (refreshToken) localStorage.setItem('ide_refresh_token', refreshToken);
    if (res.user) localStorage.setItem('ide_user', JSON.stringify(res.user));
    sessionExpiredHandled = false;
    await loadUser();
    showApp();
    initTabs();
    switchTab('registrar');
  } catch (err) {
    showLoginAlert(err.message || 'No se pudo iniciar sesión');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ingresar';
  }
}

async function logout(silent) {
  try {
    if (refreshToken) {
      await api('POST', '/auth/logout', { refreshToken }).catch(() => {});
    }
  } finally {
    localStorage.removeItem('ide_token');
    localStorage.removeItem('ide_refresh_token');
    localStorage.removeItem('ide_user');
    token = null;
    refreshToken = null;
    currentUser = null;
    if (!silent) {
      window.location.reload();
    } else {
      showLogin();
    }
  }
}

function decodeJwt(rawToken) {
  try {
    const parts = rawToken.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '==='.slice((payload.length + 3) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch (_) {
    return null;
  }
}

async function loadUser() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('ide_user') || 'null'); } catch (_) { stored = null; }

  const decoded = token ? decodeJwt(token) : null;

  currentUser = {
    id: (stored && stored.id) || (decoded && (decoded.id || decoded.sub)) || null,
    nombre: (stored && stored.nombre) || (decoded && decoded.email) || 'Usuario',
    email: (stored && stored.email) || (decoded && decoded.email) || '',
    entidad_id: (stored && stored.entidad_id) || (decoded && decoded.entidad_id) || null,
    roles: (stored && stored.roles) || (decoded && decoded.roles) || [],
  };

  const nameEl = qs('#user-name');
  const roleEl = qs('#user-role');
  if (nameEl) nameEl.textContent = currentUser.nombre || currentUser.email;
  if (roleEl) {
    const primaryRole = (currentUser.roles[0] && currentUser.roles[0].rol) || 'usuario';
    roleEl.textContent = primaryRole;
  }

  cargarNotificaciones();
}

function showApp() {
  qs('#login-screen').classList.add('hidden');
  qs('#app-shell').classList.remove('hidden');
}

function showLogin() {
  qs('#app-shell').classList.add('hidden');
  qs('#login-screen').classList.remove('hidden');
}

/* ============================================================
   TABS
   ============================================================ */

const TAB_LOADERS = {
  registrar: cargarRegistrar,
  cargas: cargarCargas,
  datasets: cargarDatasets,
  servicios: cargarServicios,
  calidad: cargarCalidad,
  metadatos: cargarMetadatos,
  estilos: cargarEstilos,
  usuarios: cargarUsuarios,
  monitoreo: cargarMonitoreo,
  auditoria: cargarAuditoria,
};

function initTabs() {
  const tabs = qsa('.nav-tab');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(btn);
      if (e.key === 'ArrowRight') { e.preventDefault(); (tabs[idx + 1] || tabs[0]).focus(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); (tabs[idx - 1] || tabs[tabs.length - 1]).focus(); }
    });
  });
}

function switchTab(name) {
  if (!TAB_LOADERS[name]) return;

  qsa('.nav-tab').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('nav-tab-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  });

  qsa('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${name}`);
  });

  try {
    TAB_LOADERS[name]();
  } catch (err) {
    showAlert(`Error al cargar la pestaña: ${err.message}`, 'error');
  }
}

/* ============================================================
   REGISTRAR ASSISTANT — the centerpiece feature
   ============================================================ */

const REG_STEPS = [
  { key: 'datos', label: 'Datos', icon: '📄' },
  { key: 'clasificacion', label: 'Clasificación', icon: '🏷️' },
  { key: 'calidad', label: 'Calidad', icon: '✅' },
  { key: 'catalogo', label: 'Catálogo', icon: '📖' },
  { key: 'simbologia', label: 'Simbología', icon: '🎨' },
  { key: 'metadatos', label: 'Metadatos', icon: '📋' },
  { key: 'publicar', label: 'Publicar', icon: '🚀' },
];

async function cargarRegistrar() {
  qs('#reg-flujo').classList.add('hidden');
  qs('#reg-inicio').classList.remove('hidden');
  regCtx = null;
  renderRegInicio();
  await renderRegEnCurso();
}

function renderRegInicio() {
  qs('#reg-inicio').innerHTML = `
    <div class="reg-options">
      <button type="button" class="reg-option-card archivo" id="reg-opt-archivo">
        <span class="reg-option-icon" aria-hidden="true">📁</span>
        <span class="reg-option-title">Cargar archivo</span>
        <span class="reg-option-desc">Shapefile, GeoJSON, GeoPackage, KML u otro formato vectorial/raster</span>
      </button>
      <button type="button" class="reg-option-card servicio" id="reg-opt-servicio">
        <span class="reg-option-icon" aria-hidden="true">🌐</span>
        <span class="reg-option-title">Registrar servicio</span>
        <span class="reg-option-desc">Conectar un servicio OGC (WMS, WFS o WCS) ya publicado</span>
      </button>
    </div>
  `;
  qs('#reg-opt-archivo').addEventListener('click', regAltaArchivo);
  qs('#reg-opt-servicio').addEventListener('click', regAltaServicio);
}

async function renderRegEnCurso() {
  const box = qs('#reg-encurso');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando registros en curso…</div>';
  try {
    const res = await api('GET', '/recursos?estado_no=publicado');
    const recursos = normList(res).filter((r) => !['publicado', 'activo'].includes(r.estado));

    if (!recursos.length) {
      box.innerHTML = '';
      return;
    }

    box.innerHTML = `
      <div class="reg-encurso-title">Registros en curso</div>
      <div class="reg-encurso-list">
        ${recursos.map((r) => {
          const tipo = r.tipo_recurso || r.tipo || 'dataset';
          const estado = regEstado(tipo, r);
          const done = Object.values(estado).filter(Boolean).length;
          const total = Object.keys(estado).length;
          const pct = Math.round((done / total) * 100);
          const cls = pct >= 80 ? 'ok' : pct >= 40 ? 'warn' : 'bad';
          return `
            <div class="reg-encurso-item" role="button" tabindex="0" onclick="abrirRegistro('${tipo}', ${r.id})">
              <span class="reg-option-icon" style="font-size:1.4rem" aria-hidden="true">${tipo === 'servicio' ? '🌐' : '📁'}</span>
              <span class="reg-encurso-name">${esc(r.titulo || r.nombre || '(sin nombre)')}</span>
              <div class="reg-encurso-progress">
                <div class="progress-bar-wrap"><div class="progress-bar ${cls}" style="width:${pct}%"></div></div>
                <span class="pill pill-${cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : 'ok'}">${done}/${total}</span>
              </div>
              <span class="pill pill-info">${esc(r.entidad_nombre || '')}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

/* ---------- Alta de archivo ---------- */

async function regAltaArchivo() {
  let entidades = [];
  try { entidades = await fetchEntidades(); } catch (_) { entidades = []; }

  qs('#reg-inicio').innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Cargar archivo geoespacial</h3>
        <button type="button" class="btn btn-ghost dark btn-sm" id="reg-archivo-volver">← Volver</button>
      </div>
      <form id="reg-archivo-form" novalidate>
        <div class="form-group">
          <label class="form-label required" for="reg-archivo-entidad">Entidad</label>
          <select id="reg-archivo-entidad" class="form-select" required aria-required="true">
            <option value="">Seleccione…</option>
            ${entidades.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label required" for="reg-archivo-nombre">Nombre del conjunto de datos</label>
          <input id="reg-archivo-nombre" class="form-control" type="text" required aria-required="true" placeholder="Ej. Red vial nacional 2026">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-archivo-file">Archivo</label>
          <div id="reg-drop-zone" class="drop-zone" tabindex="0" role="button" aria-describedby="reg-drop-hint">
            <span class="drop-zone-icon" aria-hidden="true">📁</span>
            <span class="drop-zone-label" id="reg-drop-label">Arrastre el archivo aquí o haga clic para seleccionar</span>
            <span class="drop-zone-hint" id="reg-drop-hint">Shapefile (.zip), GeoJSON, GeoPackage, KML — máx. 500 MB</span>
          </div>
          <input id="reg-archivo-file" type="file" class="hidden" required aria-required="true"
                 accept=".zip,.geojson,.json,.gpkg,.kml,.kmz,.tif,.tiff">
        </div>
        <div id="reg-archivo-progreso" class="hidden">
          <div class="progress-row">
            <span class="spinner" aria-hidden="true"></span>
            <div class="progress-bar-wrap"><div class="progress-bar" id="reg-archivo-progreso-bar" style="width:0%"></div></div>
            <span id="reg-archivo-progreso-label">Subiendo…</span>
          </div>
        </div>
        <button type="submit" class="btn btn-primary" id="reg-archivo-submit">Subir y continuar</button>
      </form>
    </div>
  `;

  qs('#reg-archivo-volver').addEventListener('click', cargarRegistrar);

  const dropZone = qs('#reg-drop-zone');
  const fileInput = qs('#reg-archivo-file');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach((evt) => dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach((evt) => dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over');
  }));
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      updateDropLabel();
    }
  });
  fileInput.addEventListener('change', updateDropLabel);
  function updateDropLabel() {
    if (fileInput.files && fileInput.files[0]) {
      qs('#reg-drop-label').textContent = `${fileInput.files[0].name} (${fmtBytes(fileInput.files[0].size)})`;
    }
  }

  qs('#reg-archivo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const entidadId = qs('#reg-archivo-entidad').value;
    const nombre = qs('#reg-archivo-nombre').value.trim();
    const file = fileInput.files[0];
    if (!entidadId || !nombre || !file) {
      showAlert('Complete todos los campos y seleccione un archivo', 'warning');
      return;
    }

    const fd = new FormData();
    fd.append('entidad_id', entidadId);
    fd.append('nombre', nombre);
    fd.append('archivo', file);

    qs('#reg-archivo-submit').disabled = true;
    qs('#reg-archivo-progreso').classList.remove('hidden');
    qs('#reg-archivo-progreso-label').textContent = 'Subiendo archivo…';

    try {
      const res = await apiForm('/uploads', fd, 'POST');
      const upload = normObj(res);
      await regPollUpload(upload.id);
    } catch (err) {
      showAlert(`Error al subir el archivo: ${err.message}`, 'error');
      qs('#reg-archivo-submit').disabled = false;
      qs('#reg-archivo-progreso').classList.add('hidden');
    }
  });
}

async function regPollUpload(uploadId) {
  const label = qs('#reg-archivo-progreso-label');
  const bar = qs('#reg-archivo-progreso-bar');
  const TERMINAL = ['en_revision', 'publicado', 'rechazado', 'validado'];
  let attempts = 0;

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      attempts++;
      try {
        const res = await api('GET', `/uploads/${uploadId}`);
        const upload = normObj(res);
        if (label) label.textContent = `Estado: ${upload.estado || '…'}`;
        if (bar) bar.style.width = `${Math.min(95, attempts * 8)}%`;

        if (upload.estado === 'rechazado') {
          clearInterval(timer);
          showAlert(`Carga rechazada: ${upload.error_mensaje || 'revise el archivo'}`, 'error');
          qs('#reg-archivo-submit') && (qs('#reg-archivo-submit').disabled = false);
          resolve();
          return;
        }

        if (TERMINAL.includes(upload.estado)) {
          clearInterval(timer);
          if (bar) bar.style.width = '100%';
          const datasetId = upload.dataset_id || (upload.dataset && upload.dataset.id);
          if (datasetId) {
            showAlert('Archivo cargado correctamente. Continúe con la clasificación.', 'success');
            await abrirRegistro('dataset', datasetId, 'clasificacion');
          } else {
            showAlert('Carga procesada, pero no se generó un dataset aún. Revise la pestaña Cargas.', 'warning');
          }
          resolve();
        }

        if (attempts > 150) { // ~5 minutes
          clearInterval(timer);
          showAlert('La carga está tardando más de lo esperado. Revise la pestaña Cargas.', 'warning');
          resolve();
        }
      } catch (err) {
        clearInterval(timer);
        showAlert(`Error al consultar el estado de la carga: ${err.message}`, 'error');
        resolve();
      }
    }, 2000);
  });
}

/* ---------- Alta de servicio ---------- */

async function regAltaServicio() {
  let entidades = [];
  try { entidades = await fetchEntidades(); } catch (_) { entidades = []; }

  qs('#reg-inicio').innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Registrar servicio OGC</h3>
        <button type="button" class="btn btn-ghost dark btn-sm" id="reg-servicio-volver">← Volver</button>
      </div>
      <form id="reg-servicio-form" novalidate>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label required" for="reg-servicio-entidad">Entidad</label>
            <select id="reg-servicio-entidad" class="form-select" required aria-required="true">
              <option value="">Seleccione…</option>
              ${entidades.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label required" for="reg-servicio-tipo">Tipo de servicio</label>
            <select id="reg-servicio-tipo" class="form-select" required aria-required="true">
              <option value="WMS">WMS</option>
              <option value="WFS">WFS</option>
              <option value="WCS">WCS</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label required" for="reg-servicio-nombre">Nombre del servicio</label>
          <input id="reg-servicio-nombre" class="form-control" type="text" required aria-required="true" placeholder="Ej. WMS Límites administrativos">
        </div>
        <div class="form-group">
          <label class="form-label required" for="reg-servicio-url">URL base</label>
          <input id="reg-servicio-url" class="form-control" type="url" required aria-required="true" placeholder="https://geoserver.entidad.gob.pe/geoserver/wms">
          <span class="form-hint">URL del endpoint del servicio (sin parámetros de consulta)</span>
        </div>
        <button type="submit" class="btn btn-primary" id="reg-servicio-submit">Registrar y continuar</button>
      </form>
    </div>
  `;

  qs('#reg-servicio-volver').addEventListener('click', cargarRegistrar);

  qs('#reg-servicio-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const entidad_id = qs('#reg-servicio-entidad').value;
    const tipo = qs('#reg-servicio-tipo').value;
    const nombre = qs('#reg-servicio-nombre').value.trim();
    const url_base = qs('#reg-servicio-url').value.trim();
    if (!entidad_id || !tipo || !nombre || !url_base) {
      showAlert('Complete todos los campos requeridos', 'warning');
      return;
    }
    qs('#reg-servicio-submit').disabled = true;
    try {
      const res = await api('POST', '/servicios', { entidad_id: Number(entidad_id), tipo, nombre, url_base });
      const servicio = normObj(res);
      showAlert('Servicio registrado correctamente. Continúe con la clasificación.', 'success');
      await abrirRegistro('servicio', servicio.id, 'clasificacion');
    } catch (err) {
      showAlert(`Error al registrar el servicio: ${err.message}`, 'error');
      qs('#reg-servicio-submit').disabled = false;
    }
  });
}

/* ---------- Step-completion state ---------- */

function regEstado(tipo, recurso) {
  const scoreKnown = (recurso.scores && Object.keys(recurso.scores).length > 0)
    || recurso.quality_score !== null && recurso.quality_score !== undefined;
  return {
    datos: true,
    clasificacion: !!recurso.codigo_unico,
    calidad: !!scoreKnown,
    catalogo: !!recurso.tiene_catalogo,
    simbologia: !!recurso.tiene_simbologia,
    metadatos: !!recurso.tiene_metadatos,
    publicar: recurso.estado === 'publicado' || recurso.estado === 'activo',
  };
}

/* ---------- Main flow ---------- */

async function abrirRegistro(tipo, id, paso) {
  try {
    const res = await api('GET', `/recursos/${tipo}/${id}`);
    const recurso = normObj(res);
    regCtx = { tipo, id, recurso };

    qs('#reg-inicio').classList.add('hidden');
    qs('#reg-flujo').classList.remove('hidden');

    const estado = regEstado(tipo, recurso);
    const first = paso || (REG_STEPS.find((s) => !estado[s.key]) || REG_STEPS[0]).key;
    renderRegStepper(estado, first);
    await regRenderPaso(first, regCtx);
  } catch (err) {
    showAlert(`Error al abrir el registro: ${err.message}`, 'error');
  }
}

function renderRegStepper(estado, activeKey) {
  const stepper = qs('#reg-stepper');
  stepper.innerHTML = REG_STEPS.map((s, i) => {
    const cls = s.key === activeKey ? 'active' : estado[s.key] ? 'done' : 'pending';
    const chip = `
      <button type="button" class="reg-step-chip ${cls}" data-step="${s.key}"
              role="tab" aria-selected="${s.key === activeKey}"
              onclick="regGoPaso('${s.key}')">
        <span aria-hidden="true">${estado[s.key] && s.key !== activeKey ? '✔' : s.icon}</span> ${s.label}
      </button>`;
    return i < REG_STEPS.length - 1 ? chip + '<span class="reg-step-connector" aria-hidden="true"></span>' : chip;
  }).join('');
}

function regGoPaso(key) {
  if (!regCtx) return;
  qsa('.reg-step-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.step === key);
    c.setAttribute('aria-selected', c.dataset.step === key ? 'true' : 'false');
  });
  regRenderPaso(key, regCtx);
}

async function regRenderPaso(clave, ctx) {
  const box = qs('#reg-contenido');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  const { tipo, id, recurso } = ctx;

  try {
    switch (clave) {
      case 'datos': return regPasoDatos(box, tipo, id, recurso);
      case 'clasificacion': return regPasoClasificacion(box, tipo, id, recurso);
      case 'calidad': return regPasoCalidad(box, tipo, id, recurso);
      case 'catalogo': return renderCatalogo(tipo, id, '#reg-contenido', 'completo');
      case 'simbologia': return renderCatalogo(tipo, id, '#reg-contenido', 'simbologia');
      case 'metadatos': return renderFormularioMetadato(
        recurso.metadato && recurso.metadato.id, '#reg-contenido',
        () => abrirRegistro(tipo, id, 'metadatos'), tipo, id
      );
      case 'publicar': return regPasoPublicar(box, tipo, id, recurso);
      default: box.innerHTML = '<p>Paso no reconocido.</p>';
    }
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

function regPasoDatos(box, tipo, id, r) {
  if (tipo === 'dataset') {
    box.innerHTML = `
      <div class="section-header"><h3>Datos del conjunto</h3></div>
      <form id="reg-datos-form" class="form-row">
        <div class="form-group">
          <label class="form-label" for="reg-datos-nombre">Nombre</label>
          <input id="reg-datos-nombre" class="form-control" value="${esc(r.titulo || r.nombre || '')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-datos-entidad">Entidad</label>
          <input class="form-control" value="${esc(r.entidad_nombre || '')}" disabled>
        </div>
      </form>
      <div class="form-group">
        <label class="form-label" for="reg-datos-desc">Descripción</label>
        <textarea id="reg-datos-desc" class="form-control">${esc(r.descripcion || '')}</textarea>
      </div>
      <div class="form-group">
        <span class="pill pill-info">Estado: ${esc(r.estado || '—')}</span>
        ${r.codigo_unico ? `<span class="pill pill-ok">Código: ${esc(r.codigo_unico)}</span>` : ''}
      </div>
      <button type="button" class="btn btn-primary" id="reg-datos-guardar">Guardar cambios</button>
    `;
    qs('#reg-datos-guardar').addEventListener('click', async () => {
      try {
        await api('PUT', `/datasets/${id}`, {
          nombre: qs('#reg-datos-nombre').value.trim(),
          descripcion: qs('#reg-datos-desc').value.trim(),
        });
        showAlert('Datos actualizados', 'success');
        await abrirRegistro(tipo, id, 'datos');
      } catch (err) { showAlert(err.message, 'error'); }
    });
  } else {
    box.innerHTML = `
      <div class="section-header"><h3>Datos del servicio</h3></div>
      <form id="reg-datos-form" class="form-row">
        <div class="form-group">
          <label class="form-label" for="reg-datos-nombre">Nombre</label>
          <input id="reg-datos-nombre" class="form-control" value="${esc(r.titulo || r.nombre || '')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-datos-tipo">Tipo</label>
          <input class="form-control" value="${esc(r.tipo || '')}" disabled>
        </div>
      </form>
      <div class="form-group">
        <label class="form-label" for="reg-datos-url">URL base</label>
        <input id="reg-datos-url" class="form-control" value="${esc(r.url_base || '')}">
      </div>
      <div class="form-group">
        <span class="pill pill-info">Estado: ${esc(r.estado || '—')}</span>
        ${r.codigo_unico ? `<span class="pill pill-ok">Código: ${esc(r.codigo_unico)}</span>` : ''}
      </div>
      <button type="button" class="btn btn-primary" id="reg-datos-guardar">Guardar cambios</button>
    `;
    qs('#reg-datos-guardar').addEventListener('click', async () => {
      try {
        await api('PUT', `/servicios/${id}`, {
          nombre: qs('#reg-datos-nombre').value.trim(),
          url_base: qs('#reg-datos-url').value.trim(),
        });
        showAlert('Datos actualizados', 'success');
        await abrirRegistro(tipo, id, 'datos');
      } catch (err) { showAlert(err.message, 'error'); }
    });
  }
}

async function regPasoClasificacion(box, tipo, id, r) {
  const res = await api('GET', '/clasificacion/temas');
  const temas = normList(res);

  box.innerHTML = `
    <div class="section-header"><h3>Clasificación temática</h3></div>
    ${r.codigo_unico ? `<div class="alert alert-success"><span class="alert-body">Código único asignado: <strong>${esc(r.codigo_unico)}</strong></span></div>` : ''}
    <div class="form-row">
      <div class="form-group">
        <label class="form-label required" for="reg-clas-tema">Tema</label>
        <select id="reg-clas-tema" class="form-select" required aria-required="true">
          <option value="">Seleccione un tema…</option>
          ${temas.map((t) => `<option value="${esc(t.codigo)}" ${t.codigo === r.tema_codigo ? 'selected' : ''}>${esc(t.codigo)} — ${esc(t.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label required" for="reg-clas-subtema">Subtema</label>
        <select id="reg-clas-subtema" class="form-select" required aria-required="true">
          <option value="">Seleccione un tema primero…</option>
        </select>
      </div>
    </div>
    <button type="button" class="btn btn-primary" id="reg-clas-guardar">Guardar clasificación</button>
  `;

  const temaSel = qs('#reg-clas-tema');
  const subtemaSel = qs('#reg-clas-subtema');

  function fillSubtemas(temaCodigo, selected) {
    const tema = temas.find((t) => t.codigo === temaCodigo);
    const subtemas = (tema && tema.subtemas) || [];
    subtemaSel.innerHTML = `<option value="">Seleccione…</option>` +
      subtemas.map((s) => `<option value="${esc(s.codigo)}" ${s.codigo === selected ? 'selected' : ''}>${esc(s.codigo)} — ${esc(s.nombre)}</option>`).join('');
  }

  if (r.tema_codigo) fillSubtemas(r.tema_codigo, r.subtema_codigo);
  temaSel.addEventListener('change', () => fillSubtemas(temaSel.value));

  qs('#reg-clas-guardar').addEventListener('click', async () => {
    const tema_codigo = temaSel.value;
    const subtema_codigo = subtemaSel.value;
    if (!tema_codigo || !subtema_codigo) {
      showAlert('Seleccione tema y subtema', 'warning');
      return;
    }
    try {
      await api('PUT', `/clasificacion/${tipo}/${id}`, { tema_codigo, subtema_codigo });
      showAlert('Clasificación asignada correctamente', 'success');
      await abrirRegistro(tipo, id, 'clasificacion');
    } catch (err) { showAlert(err.message, 'error'); }
  });
}

async function regPasoCalidad(box, tipo, id, r) {
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando reporte de calidad…</div>';
  try {
    let reporte = null;
    if (tipo === 'dataset') {
      if (!r.upload_id) {
        box.innerHTML = `<div class="alert alert-warning"><span class="alert-body">Este dataset no tiene una carga asociada para evaluar calidad.</span></div>`;
        return;
      }
      reporte = normObj(await api('GET', `/calidad/upload/${r.upload_id}`));
    } else {
      try {
        reporte = normObj(await api('GET', `/calidad/servicio/${id}`));
      } catch (_) { reporte = null; }
    }
    renderReporteCalidad(box, reporte, tipo, id);
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

function renderReporteCalidad(box, reporte, tipo, id) {
  const evaluarBtn = tipo === 'servicio'
    ? `<button type="button" class="btn btn-secondary btn-sm" id="reg-calidad-evaluar">🔄 Evaluar ahora</button>` : '';

  if (!reporte) {
    box.innerHTML = `
      <div class="section-header"><h3>Control de calidad</h3></div>
      <div class="alert alert-info"><span class="alert-body">Aún no hay un reporte de calidad para este recurso.</span></div>
      ${evaluarBtn}
    `;
  } else {
    const score = reporte.score ?? 0;
    const cls = scoreClass(score);
    const checks = normList({ data: reporte.checks || reporte.quality_check_results || [] });
    box.innerHTML = `
      <div class="section-header"><h3>Control de calidad</h3></div>
      <div class="score-meter">
        <div class="score-value ${cls}">${score}</div>
        <div>
          <div class="score-label">Puntaje sobre 100 · ${esc(reporte.resultado_global || '')}</div>
          <div class="score-label">${reporte.checks_ok || 0} OK · ${reporte.checks_advertencia || 0} advertencias · ${reporte.checks_falla || 0} fallas</div>
        </div>
      </div>
      ${evaluarBtn}
      <div class="checklist" style="margin-top:16px">
        ${checks.length ? checks.map((c) => `
          <div class="check-item ${c.resultado === 'pasa' ? 'ok' : c.resultado === 'advertencia' ? 'warn' : 'error'}">
            <span class="check-icon" aria-hidden="true">${c.resultado === 'pasa' ? '✅' : c.resultado === 'advertencia' ? '⚠️' : '❌'}</span>
            <div>
              <div class="check-label">${esc(c.chequeo)}</div>
              <div class="check-detail">Valor obtenido: ${esc(c.valor_obtenido ?? '—')}${c.umbral ? ` · Umbral: ${esc(c.umbral)}` : ''}</div>
            </div>
          </div>
        `).join('') : '<p class="score-label">Sin chequeos individuales registrados.</p>'}
      </div>
    `;
  }

  const btn = qs('#reg-calidad-evaluar');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Evaluando…';
      try {
        const res = await api('POST', `/calidad/servicio/${id}`);
        renderReporteCalidad(box, normObj(res), tipo, id);
        showAlert('Evaluación de calidad completada', 'success');
      } catch (err) {
        showAlert(err.message, 'error');
        btn.disabled = false;
        btn.textContent = '🔄 Evaluar ahora';
      }
    });
  }
}

function scoreClass(score) {
  if (score === null || score === undefined) return '';
  return score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
}

function regPasoPublicar(box, tipo, id, r) {
  const wmsUrl = r.wms_url || (tipo === 'servicio' && r.tipo === 'WMS' ? r.url_base : (tipo === 'dataset' && r.geoserver_workspace && r.geoserver_layer ? `${location.origin}/geoserver/${r.geoserver_workspace}/wms` : null));
  const wfsUrl = r.wfs_url || (tipo === 'servicio' && r.tipo === 'WFS' ? r.url_base : (tipo === 'dataset' && r.geoserver_workspace && r.geoserver_layer ? `${location.origin}/geoserver/${r.geoserver_workspace}/wfs` : null));

  const estado = regEstado(tipo, r);
  const pendientes = REG_STEPS.filter((s) => s.key !== 'publicar' && !estado[s.key]);
  const puedePublicar = pendientes.length === 0 && tipo === 'dataset' && r.estado === 'en_revision';

  box.innerHTML = `
    <div class="section-header"><h3>Publicación</h3></div>
    <div class="grid-2">
      <div class="card">
        <div class="card-title">Estado general</div>
        <p style="margin-top:8px">${estadoPillHtml(r.estado)}</p>
        ${pendientes.length ? `<p class="check-detail">Pasos pendientes: ${pendientes.map((p) => esc(p.label)).join(', ')}</p>` : '<p class="check-detail">Todos los pasos previos están completos.</p>'}
      </div>
      <div class="card">
        <div class="card-title">URLs de servicio OGC</div>
        ${wmsUrl ? `<div class="ogc-url-box"><span aria-hidden="true">🗺️</span><a href="${esc(wmsUrl)}" target="_blank" rel="noopener">${esc(wmsUrl)}</a></div>` : ''}
        ${wfsUrl ? `<div class="ogc-url-box"><span aria-hidden="true">📡</span><a href="${esc(wfsUrl)}" target="_blank" rel="noopener">${esc(wfsUrl)}</a></div>` : ''}
        ${!wmsUrl && !wfsUrl ? '<p class="check-detail">Sin URLs OGC disponibles aún.</p>' : ''}
      </div>
    </div>
    ${tipo === 'dataset' ? `
      <button type="button" class="btn btn-primary" id="reg-publicar-btn" ${puedePublicar ? '' : 'disabled'}>
        🚀 Aprobar y publicar
      </button>
      ${!puedePublicar ? '<p class="form-hint">Complete todos los pasos y asegúrese de que el dataset esté en revisión para poder publicarlo.</p>' : ''}
    ` : `<p class="form-hint">Los servicios se consideran publicados cuando su estado es «activo».</p>`}
  `;

  const pubBtn = qs('#reg-publicar-btn');
  if (pubBtn) {
    pubBtn.addEventListener('click', async () => {
      pubBtn.disabled = true;
      try {
        await api('POST', `/datasets/${id}/aprobar`);
        showAlert('Dataset publicado exitosamente', 'success');
        await abrirRegistro(tipo, id, 'publicar');
        await renderRegEnCurso();
      } catch (err) {
        showAlert(err.message, 'error');
        pubBtn.disabled = false;
      }
    });
  }
}

function estadoPillHtml(estado) {
  const map = {
    publicado: 'ok', activo: 'ok', aprobado: 'ok', completado: 'ok', sincronizado: 'ok', validado: 'ok',
    en_revision: 'warn', procesando: 'warn', inspeccionado: 'warn', convertido: 'warn', degradado: 'warn',
    borrador: 'pendiente', recibido: 'pendiente', pendiente: 'pendiente',
    rechazado: 'bad', error: 'bad', fallido: 'bad', caido: 'bad', inactivo: 'bad', archivado: 'bad',
  };
  const cls = map[estado] || 'info';
  return `<span class="pill pill-${cls}">${esc(estado || '—')}</span>`;
}

/* ============================================================
   REUSABLE: CATÁLOGO DE OBJETOS / SIMBOLOGÍA
   ============================================================ */

async function renderCatalogo(tipo, recursoId, containerSel, modo) {
  const box = qs(containerSel);
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando catálogo…</div>';

  let catalogo = null;
  try {
    const res = await api('GET', `/catalogo-objetos/${tipo}/${recursoId}`);
    catalogo = normObj(res);
  } catch (err) {
    box.innerHTML = `
      <div class="section-header"><h3>${modo === 'simbologia' ? 'Simbología' : 'Catálogo de objetos'}</h3></div>
      <div class="alert alert-info"><span class="alert-body">Aún no existe un catálogo de objetos para este recurso.</span></div>
      <button type="button" class="btn btn-primary" id="reg-catalogo-pregenerar">Pre-generar catálogo</button>
    `;
    qs('#reg-catalogo-pregenerar').addEventListener('click', async () => {
      try {
        await api('POST', `/catalogo-objetos/${tipo}/${recursoId}/pregenerar`);
        showAlert('Catálogo generado correctamente', 'success');
        renderCatalogo(tipo, recursoId, containerSel, modo);
      } catch (err2) { showAlert(err2.message, 'error'); }
    });
    return;
  }

  const featureTypes = (catalogo && (catalogo.feature_types || catalogo.tipos_objeto)) || [];

  if (modo === 'simbologia') {
    let estilos = [];
    try { estilos = await fetchEstilos(); } catch (_) { estilos = []; }

    box.innerHTML = `
      <div class="section-header"><h3>Asignación de simbología</h3></div>
      ${!featureTypes.length ? '<p class="score-label">El catálogo no tiene tipos de objeto (feature types) definidos.</p>' : `
        <div class="table-wrapper">
          <table class="table table-striped">
            <thead><tr><th>Tipo de objeto</th><th>Estilo asignado</th></tr></thead>
            <tbody>
              ${featureTypes.map((ft) => `
                <tr>
                  <td>${esc(ft.alias || ft.nombre)}</td>
                  <td>
                    <select class="form-select" data-ft="${ft.id}" onchange="regAsignarEstilo(this)">
                      <option value="">Sin estilo</option>
                      ${estilos.map((e) => `<option value="${e.id}" ${e.id === ft.style_id ? 'selected' : ''}>${esc(e.nombre)}${e.tipo_geometria ? ` (${esc(e.tipo_geometria)})` : ''}</option>`).join('')}
                    </select>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    `;
  } else {
    box.innerHTML = `
      <div class="section-header"><h3>Catálogo de objetos (ISO 19110)</h3></div>
      ${!featureTypes.length ? '<p class="score-label">El catálogo no tiene tipos de objeto (feature types) definidos.</p>' : featureTypes.map((ft) => `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header"><div class="card-title">${esc(ft.alias || ft.nombre)}</div>
            <span class="chip">${esc(ft.nombre)}</span>
          </div>
          <div class="table-wrapper">
            <table class="table">
              <thead><tr><th>Atributo</th><th>Alias</th><th>Definición</th><th>Tipo de dato</th><th>Dominio</th></tr></thead>
              <tbody>
                ${(ft.atributos || ft.attributes || []).map((a) => `
                  <tr>
                    <td>${esc(a.nombre)}</td>
                    <td><input class="cell-edit" value="${esc(a.alias || '')}" data-attr="${a.id}" data-field="alias" onblur="regGuardarAtributo(this)"></td>
                    <td><input class="cell-edit" value="${esc(a.definicion || '')}" data-attr="${a.id}" data-field="definicion" onblur="regGuardarAtributo(this)"></td>
                    <td><span class="chip">${esc(a.tipo_dato || '—')}</span></td>
                    <td><span class="badge badge-info">${esc(a.tipo_dominio || 'libre')}</span>${a.obligatorio ? ' <span class="badge badge-warn">obligatorio</span>' : ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `).join('')}
    `;
  }
}

async function regAsignarEstilo(selectEl) {
  const featureTypeId = selectEl.dataset.ft;
  const estiloId = selectEl.value;
  if (!estiloId) return;
  try {
    await api('POST', `/estilos/${estiloId}/asignar`, { feature_type_id: Number(featureTypeId) });
    showAlert('Estilo asignado correctamente', 'success');
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

async function regGuardarAtributo(inputEl) {
  const attrId = inputEl.dataset.attr;
  const field = inputEl.dataset.field;
  try {
    await api('PUT', `/catalogo-objetos/atributos/${attrId}`, { [field]: inputEl.value });
  } catch (err) {
    showAlert(`No se pudo guardar: ${err.message}`, 'error');
  }
}

/* ============================================================
   REUSABLE: FORMULARIO DE METADATOS
   ============================================================ */

async function renderFormularioMetadato(metadatoId, containerSel, onSave, tipo, recursoId) {
  const box = qs(containerSel);

  if (!metadatoId) {
    box.innerHTML = `
      <div class="section-header"><h3>Metadatos ISO 19139</h3></div>
      <div class="alert alert-info"><span class="alert-body">Aún no se ha generado un borrador de metadatos para este recurso.</span></div>
      <button type="button" class="btn btn-primary" id="meta-generar-btn">Generar borrador de metadatos</button>
    `;
    const btn = qs('#meta-generar-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (!tipo || !recursoId) { showAlert('No se pudo determinar el recurso de origen', 'error'); return; }
        btn.disabled = true;
        try {
          await api('POST', `/metadatos/${tipo}/${recursoId}`);
          showAlert('Borrador de metadatos generado', 'success');
          if (onSave) onSave();
        } catch (err) {
          showAlert(err.message, 'error');
          btn.disabled = false;
        }
      });
    }
    return;
  }

  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando metadatos…</div>';
  let metadato;
  try {
    metadato = normObj(await api('GET', `/metadatos/${metadatoId}`));
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
    return;
  }

  const c = metadato.contenido || {};
  const ident = c.identificacion || {};
  const resp = c.responsable || {};
  const ext = c.extension || {};
  const ref = c.referencia_espacial || {};
  const dist = c.distribucion || {};
  const cal = c.calidad || {};

  box.innerHTML = `
    <div class="section-header"><h3>Metadatos ISO 19139</h3>
      <span class="pill pill-${metadato.gn_sync_estado === 'sincronizado' ? 'ok' : metadato.gn_sync_estado === 'error' ? 'bad' : 'pendiente'}">
        GeoNetwork: ${esc(metadato.gn_sync_estado || 'pendiente')}
      </span>
    </div>
    <form id="meta-form">
      <fieldset class="form-group">
        <legend class="card-title" style="margin-bottom:12px">Identificación</legend>
        <div class="form-group">
          <label class="form-label" for="meta-titulo">Título</label>
          <input id="meta-titulo" class="form-control" value="${esc(ident.titulo || '')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="meta-resumen">Resumen</label>
          <textarea id="meta-resumen" class="form-control">${esc(ident.resumen || '')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="meta-palabras">Palabras clave (separadas por coma)</label>
            <input id="meta-palabras" class="form-control" value="${esc((ident.palabras_clave || []).join(', '))}">
          </div>
          <div class="form-group">
            <label class="form-label" for="meta-fecha">Fecha</label>
            <input id="meta-fecha" type="date" class="form-control" value="${esc((ident.fecha || '').slice(0, 10))}">
          </div>
          <div class="form-group">
            <label class="form-label" for="meta-tiporecurso">Tipo de recurso</label>
            <input id="meta-tiporecurso" class="form-control" value="${esc(ident.tipo_recurso || (tipo === 'servicio' ? 'servicio' : 'dataset'))}">
          </div>
        </div>
      </fieldset>

      <fieldset class="form-group">
        <legend class="card-title" style="margin-bottom:12px">Responsable</legend>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="meta-org">Organización</label>
            <input id="meta-org" class="form-control" value="${esc(resp.organizacion || '')}">
          </div>
          <div class="form-group">
            <label class="form-label" for="meta-email">Correo electrónico</label>
            <input id="meta-email" type="email" class="form-control" value="${esc(resp.email || '')}">
          </div>
          <div class="form-group">
            <label class="form-label" for="meta-rol">Rol</label>
            <input id="meta-rol" class="form-control" value="${esc(resp.rol || '')}">
          </div>
        </div>
      </fieldset>

      <fieldset class="form-group">
        <legend class="card-title" style="margin-bottom:12px">Extensión geográfica (BBOX)</legend>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="meta-oeste">Oeste</label><input id="meta-oeste" type="number" step="any" class="form-control" value="${esc(ext.oeste ?? '')}"></div>
          <div class="form-group"><label class="form-label" for="meta-este">Este</label><input id="meta-este" type="number" step="any" class="form-control" value="${esc(ext.este ?? '')}"></div>
          <div class="form-group"><label class="form-label" for="meta-sur">Sur</label><input id="meta-sur" type="number" step="any" class="form-control" value="${esc(ext.sur ?? '')}"></div>
          <div class="form-group"><label class="form-label" for="meta-norte">Norte</label><input id="meta-norte" type="number" step="any" class="form-control" value="${esc(ext.norte ?? '')}"></div>
        </div>
      </fieldset>

      <fieldset class="form-group">
        <legend class="card-title" style="margin-bottom:12px">Referencia espacial</legend>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="meta-epsg">Código EPSG</label><input id="meta-epsg" class="form-control" value="${esc(ref.epsg || '')}"></div>
          <div class="form-group"><label class="form-label" for="meta-escala">Escala (denominador)</label><input id="meta-escala" type="number" class="form-control" value="${esc(ref.escala_denominador ?? '')}"></div>
        </div>
      </fieldset>

      <fieldset class="form-group">
        <legend class="card-title" style="margin-bottom:12px">Distribución</legend>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="meta-wms">URL WMS</label><input id="meta-wms" class="form-control" value="${esc(dist.wms_url || '')}"></div>
          <div class="form-group"><label class="form-label" for="meta-wfs">URL WFS</label><input id="meta-wfs" class="form-control" value="${esc(dist.wfs_url || '')}"></div>
        </div>
      </fieldset>

      <fieldset class="form-group">
        <legend class="card-title" style="margin-bottom:12px">Calidad y linaje</legend>
        <div class="form-group">
          <label class="form-label" for="meta-linaje">Linaje</label>
          <textarea id="meta-linaje" class="form-control">${esc(cal.linaje || '')}</textarea>
        </div>
      </fieldset>

      <div class="table-actions">
        <button type="submit" class="btn btn-primary">Guardar</button>
        <button type="button" class="btn btn-secondary" id="meta-xml-btn">Ver XML</button>
        <button type="button" class="btn btn-secondary" id="meta-push-btn">Push a GeoNetwork</button>
      </div>
    </form>
  `;

  qs('#meta-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const contenido = {
      identificacion: {
        titulo: qs('#meta-titulo').value.trim(),
        resumen: qs('#meta-resumen').value.trim(),
        palabras_clave: qs('#meta-palabras').value.split(',').map((s) => s.trim()).filter(Boolean),
        fecha: qs('#meta-fecha').value,
        tipo_recurso: qs('#meta-tiporecurso').value.trim(),
      },
      responsable: {
        organizacion: qs('#meta-org').value.trim(),
        email: qs('#meta-email').value.trim(),
        rol: qs('#meta-rol').value.trim(),
      },
      extension: {
        oeste: parseFloat(qs('#meta-oeste').value) || null,
        este: parseFloat(qs('#meta-este').value) || null,
        sur: parseFloat(qs('#meta-sur').value) || null,
        norte: parseFloat(qs('#meta-norte').value) || null,
      },
      referencia_espacial: {
        epsg: qs('#meta-epsg').value.trim(),
        escala_denominador: parseInt(qs('#meta-escala').value, 10) || null,
      },
      distribucion: {
        wms_url: qs('#meta-wms').value.trim(),
        wfs_url: qs('#meta-wfs').value.trim(),
      },
      calidad: {
        linaje: qs('#meta-linaje').value.trim(),
      },
    };
    try {
      await api('PUT', `/metadatos/${metadatoId}`, { contenido });
      showAlert('Metadatos guardados correctamente', 'success');
      if (onSave) onSave();
    } catch (err) { showAlert(err.message, 'error'); }
  });

  qs('#meta-xml-btn').addEventListener('click', () => verXml(`/metadatos/${metadatoId}/xml`));

  qs('#meta-push-btn').addEventListener('click', async () => {
    const btn = qs('#meta-push-btn');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const res = await api('POST', `/metadatos/${metadatoId}/push`);
      const result = normObj(res);
      showAlert(
        result && result.gn_sync_estado === 'error'
          ? `Error al sincronizar con GeoNetwork: ${result.gn_sync_error || ''}`
          : 'Sincronizado con GeoNetwork correctamente',
        result && result.gn_sync_estado === 'error' ? 'error' : 'success'
      );
      if (onSave) onSave();
    } catch (err) {
      showAlert(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Push a GeoNetwork';
    }
  });
}

async function verXml(path) {
  try {
    const res = await fetch(API + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`Error ${res.status} al obtener el XML`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

async function descargarConToken(path, filename) {
  try {
    const res = await fetch(API + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`Error ${res.status} al descargar el archivo`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'descarga';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

/* ============================================================
   ENTIDADES / ESTILOS caches used across forms
   ============================================================ */

async function fetchEntidades(force) {
  if (cacheEntidades && !force) return cacheEntidades;
  const res = await api('GET', '/entidades');
  cacheEntidades = normList(res);
  return cacheEntidades;
}

async function fetchEstilos(force) {
  if (cacheEstilos && !force) return cacheEstilos;
  const res = await api('GET', '/estilos');
  cacheEstilos = normList(res);
  return cacheEstilos;
}

/* ============================================================
   CARGAS TAB
   ============================================================ */

async function cargarCargas() {
  const box = qs('#cargas-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const res = await api('GET', '/uploads');
    const uploads = normList(res);
    if (!uploads.length) {
      box.innerHTML = '<div class="alert alert-info"><span class="alert-body">Aún no hay cargas registradas.</span></div>';
      return;
    }
    box.innerHTML = `
      <div class="table-wrapper">
        <table class="table table-striped">
          <thead><tr><th>Archivo</th><th>Formato</th><th>Estado</th><th>Fecha</th><th></th></tr></thead>
          <tbody>
            ${uploads.map((u) => `
              <tr>
                <td>${esc(u.nombre_original)}</td>
                <td><span class="chip">${esc(u.formato_detectado || '—')}</span></td>
                <td>${estadoPillHtml(u.estado)}</td>
                <td>${fmtDate(u.created_at)}</td>
                <td><button type="button" class="btn btn-secondary btn-sm" onclick="verUpload(${u.id})">Ver</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

async function verUpload(id) {
  openModal('Detalle de carga', '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>');
  try {
    const [uploadRes, logRes] = await Promise.all([
      api('GET', `/uploads/${id}`),
      api('GET', `/uploads/${id}/log`).catch(() => null),
    ]);
    const upload = normObj(uploadRes);
    const log = logRes ? normList(logRes) : (upload.log_proceso || []);

    const body = `
      <div class="grid-2" style="margin-bottom:20px">
        <div><strong>Archivo:</strong> ${esc(upload.nombre_original)}</div>
        <div><strong>Formato:</strong> ${esc(upload.formato_detectado || '—')}</div>
        <div><strong>Estado:</strong> ${estadoPillHtml(upload.estado)}</div>
        <div><strong>Fecha:</strong> ${fmtDate(upload.created_at)}</div>
      </div>
      ${upload.error_mensaje ? `<div class="alert alert-error"><span class="alert-body">${esc(upload.error_mensaje)}</span></div>` : ''}
      <h3 style="margin-bottom:12px">Registro del proceso</h3>
      <div class="timeline">
        ${(log && log.length) ? log.map((item) => `
          <div class="timeline-item">
            <span class="timeline-dot ${item.nivel === 'error' ? 'err' : item.nivel === 'warning' ? 'warn' : 'ok'}"></span>
            <span class="timeline-time">${fmtDate(item.timestamp || item.fecha)}</span>
            <span class="timeline-msg">${esc(item.mensaje || item.msg || JSON.stringify(item))}</span>
          </div>
        `).join('') : '<p class="score-label">Sin eventos registrados.</p>'}
      </div>
    `;
    openModal(`Carga: ${esc(upload.nombre_original)}`, body);
  } catch (err) {
    openModal('Detalle de carga', `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`);
  }
}

/* ============================================================
   DATASETS TAB
   ============================================================ */

async function cargarDatasets() {
  const box = qs('#datasets-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const res = await api('GET', '/datasets');
    const datasets = normList(res);
    if (!datasets.length) {
      box.innerHTML = '<div class="alert alert-info"><span class="alert-body">No hay datasets registrados.</span></div>';
      return;
    }
    box.innerHTML = `
      <div class="table-wrapper">
        <table class="table table-striped">
          <thead><tr><th>Nombre</th><th>Entidad</th><th>Estado</th><th>Score</th><th></th></tr></thead>
          <tbody>
            ${datasets.map((d) => `
              <tr>
                <td>${esc(d.nombre)}</td>
                <td>${esc(d.entidad_nombre || '')}</td>
                <td>${estadoPillHtml(d.estado)}</td>
                <td>${d.score_dato !== null && d.score_dato !== undefined ? `<span class="pill pill-${scoreClass(d.score_dato) || 'info'}">${d.score_dato}</span>` : '—'}</td>
                <td><button type="button" class="btn btn-secondary btn-sm" onclick="verDataset(${d.id})">Gestionar</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div id="dataset-detalle"></div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

async function verDataset(id) {
  const detalle = qs('#dataset-detalle');
  if (!detalle) return;
  detalle.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando detalle…</div>';
  detalle.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const [dsRes, verRes] = await Promise.all([
      api('GET', `/datasets/${id}`),
      api('GET', `/datasets/${id}/versiones`),
    ]);
    const ds = normObj(dsRes);
    const versiones = normList(verRes);

    detalle.innerHTML = `
      <div class="card" style="margin-top:16px">
        <div class="card-header">
          <h3 class="card-title">${esc(ds.nombre)}</h3>
          <button type="button" class="btn btn-ghost dark btn-sm" onclick="document.getElementById('dataset-detalle').innerHTML=''">✕ Cerrar</button>
        </div>
        <div class="grid-3" style="margin-bottom:16px">
          <div><strong>Estado:</strong> ${estadoPillHtml(ds.estado)}</div>
          <div><strong>Versión actual:</strong> ${esc(ds.numero_version ?? '—')}</div>
          <div><strong>Registros:</strong> ${esc(ds.conteo_registros ?? '—')}</div>
        </div>

        <h4 style="margin-bottom:8px">Versiones</h4>
        <div class="table-wrapper" style="margin-bottom:16px">
          <table class="table">
            <thead><tr><th><input type="checkbox" disabled aria-hidden="true" style="visibility:hidden"></th><th>#</th><th>Registros</th><th>SRID</th><th>Fecha</th><th></th></tr></thead>
            <tbody>
              ${versiones.map((v) => `
                <tr>
                  <td><input type="checkbox" class="ds-ver-check" value="${v.numero_version}" aria-label="Comparar versión ${v.numero_version}"></td>
                  <td>${v.numero_version}${v.id === ds.version_actual_id ? ' <span class="pill pill-ok">activa</span>' : ''}</td>
                  <td>${esc(v.conteo_registros ?? '—')}</td>
                  <td>${esc(v.srid ?? '—')}</td>
                  <td>${fmtDate(v.created_at)}</td>
                  <td>${v.id !== ds.version_actual_id ? `<button type="button" class="btn btn-warning btn-sm" onclick="dsRollback(${id}, ${v.id}, ${v.numero_version})">Rollback</button>` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="ds-comparar-btn">Comparar versiones seleccionadas</button>
        <div id="ds-comparar-result"></div>

        <div class="section-header" style="margin-top:24px"><h3>Catálogo de objetos</h3></div>
        <div id="ds-catalogo"></div>

        <div class="section-header" style="margin-top:24px"><h3>Metadatos</h3></div>
        <div id="ds-metadatos"></div>
      </div>
    `;

    qs('#ds-comparar-btn').addEventListener('click', async () => {
      const checked = qsa('.ds-ver-check:checked').map((c) => c.value);
      if (checked.length !== 2) { showAlert('Seleccione exactamente 2 versiones para comparar', 'warning'); return; }
      const resultBox = qs('#ds-comparar-result');
      resultBox.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Comparando…</div>';
      try {
        const cmp = normObj(await api('GET', `/datasets/${id}/versiones/comparar?a=${checked[0]}&b=${checked[1]}`));
        resultBox.innerHTML = `
          <div class="card" style="margin-top:12px">
            <div class="card-title">Comparación v${cmp.version_a.numero} → v${cmp.version_b.numero}</div>
            <p class="check-detail">Diferencia de registros: ${cmp.diff.registros > 0 ? '+' : ''}${cmp.diff.registros}</p>
            ${cmp.diff.score !== null ? `<p class="check-detail">Diferencia de score de calidad: ${cmp.diff.score > 0 ? '+' : ''}${cmp.diff.score}</p>` : ''}
          </div>
        `;
      } catch (err) { resultBox.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`; }
    });

    renderCatalogo('dataset', id, '#ds-catalogo', 'completo');
    renderFormularioMetadato(ds.metadato && ds.metadato.id, '#ds-metadatos', () => verDataset(id), 'dataset', id);
  } catch (err) {
    detalle.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

async function dsRollback(datasetId, versionId, numero) {
  if (!confirm(`¿Confirma el rollback a la versión ${numero}?`)) return;
  try {
    await api('POST', `/datasets/${datasetId}/versiones/${versionId}/rollback`);
    showAlert(`Rollback a la versión ${numero} aplicado`, 'success');
    await verDataset(datasetId);
  } catch (err) { showAlert(err.message, 'error'); }
}

/* ============================================================
   SERVICIOS TAB
   ============================================================ */

async function cargarServicios() {
  const box = qs('#servicios-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const res = await api('GET', '/servicios');
    const servicios = normList(res);
    if (!servicios.length) {
      box.innerHTML = '<div class="alert alert-info"><span class="alert-body">No hay servicios registrados.</span></div>';
      return;
    }
    box.innerHTML = `
      <div class="table-wrapper">
        <table class="table table-striped">
          <thead><tr><th>Nombre</th><th>Tipo</th><th>Estado</th><th>Uptime 30d</th><th></th></tr></thead>
          <tbody>
            ${servicios.map((s) => `
              <tr>
                <td>${esc(s.nombre)}</td>
                <td><span class="chip">${esc(s.tipo)}</span></td>
                <td>${trafficLightHtml(s.estado)}</td>
                <td>${s.uptime_30d !== undefined && s.uptime_30d !== null ? `${s.uptime_30d}%` : '—'}</td>
                <td><button type="button" class="btn btn-secondary btn-sm" onclick="verServicio(${s.id})">Gestionar</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div id="servicio-detalle"></div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

function trafficLightHtml(estado) {
  const map = { activo: 'green', degradado: 'yellow', caido: 'red', inactivo: 'grey' };
  const cls = map[estado] || 'grey';
  return `<span class="traffic-light"><span class="tl-dot tl-${cls}"></span>${esc(estado || '—')}</span>`;
}

async function verServicio(id) {
  const detalle = qs('#servicio-detalle');
  if (!detalle) return;
  detalle.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando detalle…</div>';
  detalle.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const [svRes, upRes] = await Promise.all([
      api('GET', `/servicios/${id}`),
      api('GET', `/servicios/${id}/uptime`).catch(() => ({ data: [] })),
    ]);
    const sv = normObj(svRes);
    const uptime = normList(upRes);
    let replicas = [];
    try { replicas = normList(await api('GET', `/replicas?servicio_id=${id}`)); } catch (_) { replicas = []; }
    let backups = [];
    try { backups = normList(await api('GET', `/servicios/${id}/backups`)); } catch (_) { backups = []; }

    detalle.innerHTML = `
      <div class="card" style="margin-top:16px">
        <div class="card-header">
          <h3 class="card-title">${esc(sv.nombre)}</h3>
          <button type="button" class="btn btn-ghost dark btn-sm" onclick="document.getElementById('servicio-detalle').innerHTML=''">✕ Cerrar</button>
        </div>
        <div class="grid-3" style="margin-bottom:16px">
          <div><strong>Estado:</strong> ${trafficLightHtml(sv.estado)}</div>
          <div><strong>URL base:</strong> <span class="url-mono">${esc(sv.url_base)}</span></div>
          <div><strong>Fallos consecutivos:</strong> ${esc(sv.fallos_consecutivos ?? 0)}</div>
        </div>

        <h4 style="margin-bottom:8px">Historial de chequeos de salud</h4>
        <div class="uptime-grid" style="margin-bottom:16px">
          ${uptime.length ? uptime.map((u) => `
            <span class="uptime-cell ${u.uptime_pct >= 99 ? '' : u.uptime_pct >= 90 ? 'degraded' : 'down'}"
                  title="${esc(u.fecha)}: ${esc(u.uptime_pct ?? '—')}%"></span>
          `).join('') : '<p class="score-label">Sin datos de disponibilidad aún.</p>'}
        </div>

        <div class="table-actions" style="margin-bottom:16px">
          <button type="button" class="btn btn-secondary btn-sm" id="sv-backup-btn">💾 Backup</button>
          <button type="button" class="btn btn-secondary btn-sm" id="sv-replica-btn">➕ Crear réplica</button>
        </div>

        <h4 style="margin-bottom:8px">Copias de respaldo</h4>
        <div class="table-wrapper" style="margin-bottom:16px">
          <table class="table">
            <thead><tr><th>Motivo</th><th>Fecha</th><th></th></tr></thead>
            <tbody>
              ${backups.length ? backups.map((b) => `
                <tr>
                  <td><span class="chip">${esc(b.motivo)}</span></td>
                  <td>${fmtDate(b.created_at)}</td>
                  <td><button type="button" class="btn btn-warning btn-sm" onclick="svRestore(${id}, ${b.id})">Restaurar</button></td>
                </tr>
              `).join('') : '<tr><td colspan="3" class="score-label">Sin copias de respaldo.</td></tr>'}
            </tbody>
          </table>
        </div>

        <h4 style="margin-bottom:8px">Réplicas</h4>
        <div class="table-wrapper">
          <table class="table">
            <thead><tr><th>Tabla</th><th>Última sincronización</th><th></th></tr></thead>
            <tbody>
              ${replicas.length ? replicas.map((r) => `
                <tr>
                  <td>${esc(r.tabla || r.replica_tabla || '—')}</td>
                  <td>${fmtDate(r.ultima_sync)}</td>
                  <td class="table-actions">
                    <button type="button" class="btn btn-secondary btn-sm" onclick="svReplicaSync(${r.id}, ${id})">Sincronizar</button>
                    <button type="button" class="btn btn-danger btn-sm" onclick="svReplicaDelete(${r.id}, ${id})">Eliminar</button>
                  </td>
                </tr>
              `).join('') : '<tr><td colspan="3" class="score-label">Sin réplicas configuradas.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    qs('#sv-backup-btn').addEventListener('click', async () => {
      try {
        await api('POST', `/servicios/${id}/backup`);
        showAlert('Backup creado correctamente', 'success');
        verServicio(id);
      } catch (err) { showAlert(err.message, 'error'); }
    });
    qs('#sv-replica-btn').addEventListener('click', async () => {
      try {
        await api('POST', '/replicas', { servicio_id: id });
        showAlert('Réplica creada correctamente', 'success');
        verServicio(id);
      } catch (err) { showAlert(err.message, 'error'); }
    });
  } catch (err) {
    detalle.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

async function svRestore(servicioId, backupId) {
  if (!confirm('¿Confirma restaurar esta copia de respaldo?')) return;
  try {
    await api('POST', `/servicios/${servicioId}/restore/${backupId}`);
    showAlert('Servicio restaurado correctamente', 'success');
    verServicio(servicioId);
  } catch (err) { showAlert(err.message, 'error'); }
}

async function svReplicaSync(replicaId, servicioId) {
  try {
    await api('POST', `/replicas/${replicaId}/sync`);
    showAlert('Sincronización de réplica iniciada', 'success');
    verServicio(servicioId);
  } catch (err) { showAlert(err.message, 'error'); }
}

async function svReplicaDelete(replicaId, servicioId) {
  if (!confirm('¿Eliminar esta réplica?')) return;
  try {
    await api('DELETE', `/replicas/${replicaId}`);
    showAlert('Réplica eliminada', 'success');
    verServicio(servicioId);
  } catch (err) { showAlert(err.message, 'error'); }
}

/* ============================================================
   CALIDAD TAB
   ============================================================ */

let calidadChart = null;

async function cargarCalidad() {
  const box = qs('#calidad-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const res = await api('GET', '/calidad/resumen');
    const resumen = normObj(res);
    const rows = normList({ data: resumen.entidades || resumen });

    box.innerHTML = `
      <div class="chart-wrapper"><canvas id="calidad-chart" height="90"></canvas></div>
      <div class="table-wrapper">
        <table class="table table-striped">
          <thead><tr><th>Entidad</th><th>Score promedio</th><th>Recursos evaluados</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.entidad || r.entidad_nombre)}</td>
                <td><span class="pill pill-${scoreClass(r.score_promedio) || 'info'}">${esc(r.score_promedio ?? '—')}</span></td>
                <td>${esc(r.total ?? r.recursos ?? '—')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    if (window.Chart && rows.length) {
      const ctx = qs('#calidad-chart').getContext('2d');
      if (calidadChart) calidadChart.destroy();
      calidadChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: rows.map((r) => r.entidad || r.entidad_nombre),
          datasets: [{
            label: 'Score de calidad promedio',
            data: rows.map((r) => r.score_promedio || 0),
            backgroundColor: '#1363D0',
            borderRadius: 4,
          }],
        },
        options: {
          responsive: true,
          scales: { y: { beginAtZero: true, max: 100 } },
          plugins: { legend: { display: false } },
        },
      });
    }
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

/* ============================================================
   METADATOS TAB (legacy direct access)
   ============================================================ */

async function cargarMetadatos() {
  const box = qs('#metadatos-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const [dsRes, svRes] = await Promise.all([
      api('GET', '/datasets').catch(() => ({ data: [] })),
      api('GET', '/servicios').catch(() => ({ data: [] })),
    ]);
    const rows = [
      ...normList(dsRes).map((d) => ({ ...d, tipo: 'dataset' })),
      ...normList(svRes).map((s) => ({ ...s, tipo: 'servicio' })),
    ].filter((r) => r.tiene_metadatos);

    if (!rows.length) {
      box.innerHTML = '<div class="alert alert-info"><span class="alert-body">No hay recursos con metadatos generados aún.</span></div>';
      return;
    }

    box.innerHTML = `
      <div class="table-wrapper">
        <table class="table table-striped">
          <thead><tr><th>Recurso</th><th>Tipo</th><th>Sincronización GeoNetwork</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.nombre)}</td>
                <td><span class="chip">${esc(r.tipo)}</span></td>
                <td><span class="pill pill-${r.metadato && r.metadato.gn_sync_estado === 'sincronizado' ? 'ok' : r.metadato && r.metadato.gn_sync_estado === 'error' ? 'bad' : 'pendiente'}">${esc((r.metadato && r.metadato.gn_sync_estado) || 'pendiente')}</span></td>
                <td><button type="button" class="btn btn-secondary btn-sm" onclick="metaAbrirModal('${r.tipo}', ${r.id}, ${r.metadato ? r.metadato.id : 'null'})">Gestionar</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

function metaAbrirModal(tipo, recursoId, metadatoId) {
  openModal('Metadatos', '<div id="meta-modal-body"></div>');
  renderFormularioMetadato(metadatoId, '#meta-modal-body', () => metaAbrirModal(tipo, recursoId, metadatoId), tipo, recursoId);
}

/* ============================================================
   ESTILOS TAB
   ============================================================ */

async function cargarEstilos() {
  const box = qs('#estilos-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const [estilos, entidades] = await Promise.all([fetchEstilos(true), fetchEntidades()]);

    box.innerHTML = `
      <div class="grid-2">
        <div>
          <div class="table-wrapper">
            <table class="table table-striped">
              <thead><tr><th>Nombre</th><th>Geometría</th><th>Entidad</th></tr></thead>
              <tbody>
                ${estilos.length ? estilos.map((e) => `
                  <tr>
                    <td>${esc(e.nombre)}</td>
                    <td><span class="chip">${esc(e.tipo_geometria || '—')}</span></td>
                    <td>${esc(e.entidad_nombre || '—')}</td>
                  </tr>
                `).join('') : '<tr><td colspan="3" class="score-label">Sin estilos registrados.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Nuevo estilo</div>
          <form id="estilo-form" style="margin-top:12px">
            <div class="form-group">
              <label class="form-label required" for="estilo-nombre">Nombre</label>
              <input id="estilo-nombre" class="form-control" required aria-required="true">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="estilo-geom">Tipo de geometría</label>
                <select id="estilo-geom" class="form-select">
                  <option value="Point">Punto</option>
                  <option value="LineString">Línea</option>
                  <option value="Polygon">Polígono</option>
                  <option value="Raster">Raster</option>
                  <option value="Any">Cualquiera</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="estilo-entidad">Entidad</label>
                <select id="estilo-entidad" class="form-select">
                  <option value="">General (IDEP)</option>
                  ${entidades.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="estilo-sld">Contenido SLD</label>
              <textarea id="estilo-sld" class="form-control" style="min-height:160px;font-family:var(--font-mono);font-size:12px" placeholder="<StyledLayerDescriptor …>"></textarea>
            </div>
            <button type="submit" class="btn btn-primary">Crear estilo</button>
          </form>
        </div>
      </div>
    `;

    qs('#estilo-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/estilos', {
          nombre: qs('#estilo-nombre').value.trim(),
          tipo_geometria: qs('#estilo-geom').value,
          entidad_id: qs('#estilo-entidad').value ? Number(qs('#estilo-entidad').value) : null,
          sld_content: qs('#estilo-sld').value,
        });
        showAlert('Estilo creado correctamente', 'success');
        cargarEstilos();
      } catch (err) { showAlert(err.message, 'error'); }
    });
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

/* ============================================================
   USUARIOS TAB
   ============================================================ */

async function cargarUsuarios() {
  const box = qs('#usuarios-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const [usuariosRes, entidades] = await Promise.all([
      api('GET', '/usuarios'),
      fetchEntidades(true),
    ]);
    const usuarios = normList(usuariosRes);

    box.innerHTML = `
      <div class="section-header"><h3>Entidades</h3></div>
      <div class="grid-2" style="margin-bottom:24px">
        <div class="table-wrapper">
          <table class="table table-striped">
            <thead><tr><th>Nombre</th><th>Sigla</th><th>Estado</th></tr></thead>
            <tbody>
              ${entidades.map((e) => `
                <tr>
                  <td>${esc(e.nombre)}</td>
                  <td><span class="chip">${esc(e.sigla || e.codigo || '—')}</span></td>
                  <td><span class="pill pill-${e.activo ? 'ok' : 'bad'}">${e.activo ? 'activa' : 'inactiva'}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-title">Nueva entidad</div>
          <form id="entidad-form" style="margin-top:12px">
            <div class="form-group"><label class="form-label required" for="ent-nombre">Nombre</label><input id="ent-nombre" class="form-control" required aria-required="true"></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label required" for="ent-codigo">Código</label><input id="ent-codigo" class="form-control" required aria-required="true"></div>
              <div class="form-group"><label class="form-label" for="ent-sigla">Sigla</label><input id="ent-sigla" class="form-control"></div>
            </div>
            <div class="form-group"><label class="form-label" for="ent-desc">Descripción</label><textarea id="ent-desc" class="form-control"></textarea></div>
            <button type="submit" class="btn btn-primary">Crear entidad</button>
          </form>
        </div>
      </div>

      <div class="section-header"><h3>Usuarios</h3></div>
      <div class="grid-2" style="margin-bottom:24px">
        <div class="table-wrapper">
          <table class="table table-striped">
            <thead><tr><th>Nombre</th><th>Correo</th><th>Roles</th><th>Estado</th></tr></thead>
            <tbody>
              ${usuarios.map((u) => `
                <tr>
                  <td>${esc(u.nombre)}</td>
                  <td>${esc(u.email)}</td>
                  <td>${(u.roles || []).map((r) => `<span class="chip chip-blue">${esc(r.rol)}</span>`).join(' ') || '—'}</td>
                  <td><span class="pill pill-${u.activo ? 'ok' : 'bad'}">${u.activo ? 'activo' : 'inactivo'}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-title">Nuevo usuario</div>
          <form id="usuario-form" style="margin-top:12px">
            <div class="form-group"><label class="form-label required" for="usr-nombre">Nombre completo</label><input id="usr-nombre" class="form-control" required aria-required="true"></div>
            <div class="form-group"><label class="form-label required" for="usr-email">Correo electrónico</label><input id="usr-email" type="email" class="form-control" required aria-required="true"></div>
            <div class="form-group"><label class="form-label required" for="usr-password">Contraseña</label><input id="usr-password" type="password" class="form-control" required aria-required="true"></div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label required" for="usr-entidad">Entidad</label>
                <select id="usr-entidad" class="form-select" required aria-required="true">
                  <option value="">Seleccione…</option>
                  ${entidades.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label required" for="usr-rol">Rol</label>
                <select id="usr-rol" class="form-select" required aria-required="true">
                  <option value="admin_ide">Administrador IDE</option>
                  <option value="admin_entidad">Administrador de entidad</option>
                  <option value="publicador">Publicador</option>
                  <option value="revisor_qa">Revisor de calidad</option>
                  <option value="lector">Lector</option>
                </select>
              </div>
            </div>
            <button type="submit" class="btn btn-primary">Crear usuario</button>
          </form>
        </div>
      </div>

      <div class="section-header"><h3>Responsables designados</h3></div>
      <div id="responsables-content"><div class="loading-placeholder"><span class="spinner"></span>Cargando…</div></div>
    `;

    qs('#entidad-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/entidades', {
          nombre: qs('#ent-nombre').value.trim(),
          codigo: qs('#ent-codigo').value.trim(),
          sigla: qs('#ent-sigla').value.trim(),
          descripcion: qs('#ent-desc').value.trim(),
        });
        showAlert('Entidad creada correctamente', 'success');
        cargarUsuarios();
      } catch (err) { showAlert(err.message, 'error'); }
    });

    qs('#usuario-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/usuarios', {
          nombre: qs('#usr-nombre').value.trim(),
          email: qs('#usr-email').value.trim(),
          password: qs('#usr-password').value,
          entidad_id: Number(qs('#usr-entidad').value),
          roles: [{ rol_nombre: qs('#usr-rol').value, entidad_id: Number(qs('#usr-entidad').value) }],
        });
        showAlert('Usuario creado correctamente', 'success');
        cargarUsuarios();
      } catch (err) { showAlert(err.message, 'error'); }
    });

    cargarResponsables(entidades);
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

async function cargarResponsables(entidades) {
  const box = qs('#responsables-content');
  if (!box) return;
  try {
    const ents = entidades || await fetchEntidades();
    const res = await api('GET', '/responsables');
    const responsables = normList(res);

    box.innerHTML = `
      <div class="grid-2">
        <div>
          ${responsables.length ? responsables.map((r) => `
            <div class="responsable-card" style="margin-bottom:12px">
              <div class="responsable-avatar" aria-hidden="true">${esc((r.nombre || '?').charAt(0).toUpperCase())}</div>
              <div style="flex:1;min-width:180px">
                <strong>${esc(r.nombre)}</strong> ${r.activo ? '' : '<span class="pill pill-bad">cesado</span>'}
                <div class="check-detail">${esc(r.cargo || '')} · ${esc(r.entidad_nombre || '')}</div>
                <div class="check-detail">${esc(r.email || '')} ${r.telefono ? '· ' + esc(r.telefono) : ''}</div>
                <div class="check-detail">Resolución ${esc(r.resolucion_numero || '—')} (${fmtDateOnly(r.resolucion_fecha)})</div>
              </div>
              <div class="table-actions">
                ${r.resolucion_pdf_ruta ? `<button type="button" class="btn btn-secondary btn-sm" onclick="descargarConToken('/responsables/${r.id}/resolucion', 'resolucion-${r.id}.pdf')">📄 Resolución</button>` : ''}
                ${r.activo ? `<button type="button" class="btn btn-danger btn-sm" onclick="responsableCesar(${r.id})">Cesar</button>` : ''}
              </div>
            </div>
          `).join('') : '<p class="score-label">No hay responsables registrados.</p>'}
        </div>
        <div class="card">
          <div class="card-title">Nuevo responsable</div>
          <form id="responsable-form" style="margin-top:12px">
            <div class="form-group"><label class="form-label required" for="resp-nombre">Nombre completo</label><input id="resp-nombre" class="form-control" required aria-required="true"></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label" for="resp-cargo">Cargo</label><input id="resp-cargo" class="form-control"></div>
              <div class="form-group">
                <label class="form-label required" for="resp-entidad">Entidad</label>
                <select id="resp-entidad" class="form-select" required aria-required="true">
                  <option value="">Seleccione…</option>
                  ${ents.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group"><label class="form-label" for="resp-email">Correo electrónico</label><input id="resp-email" type="email" class="form-control"></div>
              <div class="form-group"><label class="form-label" for="resp-tel">Teléfono</label><input id="resp-tel" class="form-control"></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label class="form-label" for="resp-resnum">N.° de resolución</label><input id="resp-resnum" class="form-control"></div>
              <div class="form-group"><label class="form-label" for="resp-resfecha">Fecha de resolución</label><input id="resp-resfecha" type="date" class="form-control"></div>
            </div>
            <div class="form-group">
              <label class="form-label" for="resp-pdf">PDF de resolución</label>
              <input id="resp-pdf" type="file" class="form-control" accept="application/pdf">
            </div>
            <button type="submit" class="btn btn-primary">Registrar responsable</button>
          </form>
        </div>
      </div>
    `;

    qs('#responsable-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const entidadId = qs('#resp-entidad').value;
      if (!entidadId) { showAlert('Seleccione una entidad', 'warning'); return; }
      const fd = new FormData();
      fd.append('nombre', qs('#resp-nombre').value.trim());
      fd.append('cargo', qs('#resp-cargo').value.trim());
      fd.append('entidad_id', entidadId);
      fd.append('email', qs('#resp-email').value.trim());
      fd.append('telefono', qs('#resp-tel').value.trim());
      fd.append('resolucion_numero', qs('#resp-resnum').value.trim());
      fd.append('resolucion_fecha', qs('#resp-resfecha').value);
      const file = qs('#resp-pdf').files[0];
      if (file) fd.append('resolucion_pdf', file);

      try {
        await apiForm('/responsables', fd, 'POST');
        showAlert('Responsable registrado correctamente', 'success');
        cargarResponsables(ents);
      } catch (err) { showAlert(err.message, 'error'); }
    });
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

async function responsableCesar(id) {
  if (!confirm('¿Confirma el cese de este responsable?')) return;
  try {
    await api('PUT', `/responsables/${id}/cesar`);
    showAlert('Responsable cesado correctamente', 'success');
    cargarResponsables();
  } catch (err) { showAlert(err.message, 'error'); }
}

/* ============================================================
   MONITOREO TAB
   ============================================================ */

let monitoreoChart = null;

async function cargarMonitoreo() {
  const box = qs('#monitoreo-content');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';
  try {
    const res = await api('GET', '/monitoreo/estado');
    const servicios = normList(res);

    box.innerHTML = `
      <div class="grid-3" id="monitoreo-cards">
        ${servicios.length ? servicios.map((s) => `
          <div class="card" role="button" tabindex="0" onclick="monitoreoVerServicio(${s.id})" style="cursor:pointer">
            <div class="card-header"><div class="card-title">${esc(s.nombre)}</div>${trafficLightHtml(s.estado)}</div>
            <p class="check-detail">Último chequeo: ${fmtDate(s.ultimo_chequeo)}</p>
            <p class="check-detail">Fallos consecutivos: ${esc(s.fallos_consecutivos ?? 0)}</p>
          </div>
        `).join('') : '<p class="score-label">No hay servicios monitoreados.</p>'}
      </div>
      <div class="chart-wrapper" style="margin-top:20px">
        <h3 id="monitoreo-chart-title" style="margin-bottom:12px">Seleccione un servicio para ver su historial de disponibilidad</h3>
        <canvas id="monitoreo-chart" height="90"></canvas>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

async function monitoreoVerServicio(id) {
  try {
    const res = await api('GET', `/monitoreo/servicio/${id}`);
    const data = normObj(res);
    const historial = normList({ data: data.uptime || data.historial || data });

    qs('#monitoreo-chart-title').textContent = `Disponibilidad — ${data.nombre || ('servicio #' + id)}`;

    if (window.Chart) {
      const ctx = qs('#monitoreo-chart').getContext('2d');
      if (monitoreoChart) monitoreoChart.destroy();
      monitoreoChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: historial.map((h) => fmtDateOnly(h.fecha)),
          datasets: [{
            label: 'Uptime %',
            data: historial.map((h) => h.uptime_pct),
            borderColor: '#1363D0',
            backgroundColor: 'rgba(19,99,208,.15)',
            tension: 0.3,
            fill: true,
          }],
        },
        options: { responsive: true, scales: { y: { beginAtZero: true, max: 100 } } },
      });
    }
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

/* ============================================================
   AUDITORIA TAB
   ============================================================ */

async function cargarAuditoria() {
  const box = qs('#auditoria-content');
  box.innerHTML = `
    <div class="filter-bar">
      <input type="date" id="aud-desde" class="form-control" aria-label="Fecha desde">
      <input type="date" id="aud-hasta" class="form-control" aria-label="Fecha hasta">
      <input type="text" id="aud-accion" class="form-control" placeholder="Acción (ej. DATASET_APROBADO)" aria-label="Filtrar por acción">
      <button type="button" class="btn btn-secondary btn-sm" id="aud-filtrar">Filtrar</button>
    </div>
    <div id="aud-tabla"></div>
  `;
  qs('#aud-filtrar').addEventListener('click', () => auditoriaCargarPagina(1));
  auditoriaCargarPagina(1);
}

async function auditoriaCargarPagina(page) {
  const box = qs('#aud-tabla');
  box.innerHTML = '<div class="loading-placeholder"><span class="spinner"></span>Cargando…</div>';

  const params = new URLSearchParams();
  params.set('page', page);
  const desde = qs('#aud-desde')?.value;
  const hasta = qs('#aud-hasta')?.value;
  const accion = qs('#aud-accion')?.value;
  if (desde) params.set('fecha_desde', desde);
  if (hasta) params.set('fecha_hasta', hasta);
  if (accion) params.set('accion', accion);

  try {
    const res = await api('GET', `/auditoria?${params.toString()}`);
    const rows = normList(res);
    const meta = (res && (res.pagination || res.meta)) || { page: 1, pages: 1, total: rows.length };

    box.innerHTML = `
      <div class="table-wrapper">
        <table class="table table-striped">
          <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Tabla</th><th>IP</th></tr></thead>
          <tbody>
            ${rows.length ? rows.map((a) => `
              <tr>
                <td>${fmtDate(a.created_at)}</td>
                <td>${esc(a.usuario_nombre || a.usuario_id || '—')}</td>
                <td><span class="chip">${esc(a.accion)}</span></td>
                <td>${esc(a.tabla_afectada || '—')}</td>
                <td>${esc(a.ip || '—')}</td>
              </tr>
            `).join('') : '<tr><td colspan="5" class="score-label">Sin registros para los filtros seleccionados.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span class="pagination-info">Página ${meta.page || 1} de ${meta.pages || 1} · ${meta.total ?? rows.length} registros</span>
        <button type="button" class="btn btn-secondary btn-sm" ${((meta.page || 1) <= 1) ? 'disabled' : ''} onclick="auditoriaCargarPagina(${(meta.page || 1) - 1})">‹ Anterior</button>
        <button type="button" class="btn btn-secondary btn-sm" ${((meta.page || 1) >= (meta.pages || 1)) ? 'disabled' : ''} onclick="auditoriaCargarPagina(${(meta.page || 1) + 1})">Siguiente ›</button>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error"><span class="alert-body">${esc(err.message)}</span></div>`;
  }
}

/* ============================================================
   NOTIFICATIONS (header bell)
   ============================================================ */

async function cargarNotificaciones() {
  try {
    const res = await api('GET', '/notificaciones');
    const notifs = normList(res);
    const unread = notifs.filter((n) => !n.leido).length;

    const badge = qs('#notif-badge');
    if (badge) {
      if (unread > 0) { badge.textContent = String(unread); badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }

    const panel = qs('#notif-panel');
    if (panel) {
      panel.innerHTML = notifs.length
        ? notifs.slice(0, 20).map((n) => `
            <div class="notif-item ${n.leido ? '' : 'unread'}">
              <div>${esc(n.mensaje)}</div>
              <div class="check-detail">${fmtDate(n.created_at)}</div>
            </div>
          `).join('')
        : '<div class="notif-item">Sin notificaciones</div>';
    }
  } catch (_) {
    // Silent: notifications are non-critical
  }
}

function toggleNotifPanel() {
  const panel = qs('#notif-panel');
  const btn = qs('#notif-btn');
  if (!panel) return;
  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willShow);
  btn?.setAttribute('aria-expanded', willShow ? 'true' : 'false');
  if (willShow) cargarNotificaciones();
}

/* ============================================================
   INIT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  qs('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = qs('#login-usuario').value.trim();
    const password = qs('#login-password').value;
    if (!email || !password) { showLoginAlert('Ingrese usuario y contraseña'); return; }
    login(email, password);
  });

  qs('#logout-btn').addEventListener('click', () => logout());

  qs('#notif-btn')?.addEventListener('click', toggleNotifPanel);
  document.addEventListener('click', (e) => {
    const wrapper = qs('#notif-btn-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      qs('#notif-panel')?.classList.add('hidden');
      qs('#notif-btn')?.setAttribute('aria-expanded', 'false');
    }
  });

  qs('.modal-close')?.addEventListener('click', closeModal);
  qs('#modal-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !qs('#modal-overlay').classList.contains('hidden')) closeModal();
  });

  initTabs();

  if (token) {
    loadUser().then(() => {
      showApp();
      switchTab('registrar');
    }).catch(() => {
      showLogin();
    });
  } else {
    showLogin();
  }

  // Refresh notifications periodically
  setInterval(() => { if (token) cargarNotificaciones(); }, 60000);
});
