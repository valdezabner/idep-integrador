// Catálogo público de descubrimiento — sin autenticación, contra /api/v1/publico
const $ = (sel) => document.querySelector(sel);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Lenguaje ciudadano: traducir términos técnicos a etiquetas comprensibles.
const TIPO_LABEL = { dataset: 'Conjunto de datos', servicio: 'Servicio de mapas' };

// Semáforo de calidad (verde ≥80, ámbar 50–79, rojo <50) reutilizando .pill.
function scorePill(dim, v) {
  const estado = v >= 80 ? 'ok' : v >= 50 ? 'warn' : 'bad';
  return `<span class="pill ${estado}" title="Calidad de ${esc(dim)}: ${v}/100">${esc(dim)} ${v}</span>`;
}

async function api(path) {
  const res = await fetch(`/api/v1/publico${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body.data !== undefined ? body.data : body;
}

async function buscar() {
  const q = $('#q').value.trim();
  const recursos = await api(`/recursos${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#detalle').classList.add('hidden');
  const count = $('#result-count');
  const title = $('#result-title');
  if (title) title.textContent = q ? `Resultados para «${q}»` : 'Recursos disponibles';
  if (count) count.textContent = recursos.length
    ? `${recursos.length} recurso${recursos.length === 1 ? '' : 's'}` : '';
  $('#resultados').innerHTML = recursos.length ? recursos.map((r) => `
    <article class="card card-recurso" tabindex="0" role="button"
             aria-label="Ver ficha de ${esc(r.titulo)}" data-tipo="${r.tipo_recurso}" data-id="${r.id}">
      <h3>${esc(r.titulo)}</h3>
      <p class="muted">${esc((r.resumen || 'Sin descripción disponible').slice(0, 180))}</p>
      <div class="tags">
        <span class="chip">${esc(TIPO_LABEL[r.tipo_recurso] || r.tipo_recurso)}</span>
        <span class="chip">${esc(r.entidad_codigo)}</span>
        ${r.codigo_unico ? `<span class="chip">${esc(r.codigo_unico)}</span>` : ''}
        ${r.tiene_metadatos ? '<span class="chip">Con ficha técnica</span>' : ''}
        ${r.tiene_catalogo ? '<span class="chip">Con diccionario de datos</span>' : ''}
      </div>
    </article>`).join('')
    : '<p class="muted">No se encontraron recursos. Pruebe con otros términos de búsqueda.</p>';
}

async function verFicha(tipo, id) {
  const f = await api(`/recursos/${tipo}/${id}`);
  const m = f.metadato || {};
  const servicios = (f.servicios || []).map((s) => `
    <li><strong>${esc(s.tipo)}</strong> <span class="url-srv">${esc(s.url_base)}</span>
      ${s.url_estable ? `<br><span class="muted">URL estable (failover): </span>
        <span class="url-srv">${location.origin}${esc(s.url_estable)}</span>` : ''}</li>`).join('');
  const diccionario = (f.diccionario || []).map((t) => `
    <h4>Tipo de objeto: ${esc(t.alias || t.nombre)}</h4>
    <table><thead><tr><th>Campo</th><th>Alias</th><th>Definición</th><th>Tipo</th><th>Dominio</th></tr></thead>
    <tbody>${(t.atributos || []).map((a) => `<tr>
      <td><code>${esc(a.nombre)}</code></td><td>${esc(a.alias || '—')}</td>
      <td>${esc(a.definicion || '—')}</td><td>${esc(a.tipo_dato || '')}</td>
      <td>${(a.dominio || []).length ? a.dominio.map((d) => esc(d.codigo)).join(', ') : '—'}</td></tr>`).join('')}
    </tbody></table>`).join('');
  const scores = Object.entries(f.scores || {})
    .map(([k, v]) => scorePill(k, v.score ?? v)).join(' ');

  $('#detalle').classList.remove('hidden');
  $('#detalle').innerHTML = `
    <button class="small ghost" onclick="document.querySelector('#detalle').classList.add('hidden')">← Volver</button>
    <h2>${esc(f.titulo)}</h2>
    ${f.codigo_unico ? `<p><span class="chip" title="Código único de clasificación temática">Código: ${esc(f.codigo_unico)}</span></p>` : ''}
    <p>${esc(m.resumen || f.descripcion || '')}</p>
    <p class="muted">${esc(f.entidad_nombre)} (${esc(f.entidad_codigo)})
      ${m.fecha ? ` · Fecha: ${esc(m.fecha)}` : ''}
      ${m.escala_denominador ? ` · Escala 1:${esc(m.escala_denominador)}` : ''}</p>
    <div>${scores}</div>
    ${(m.palabras_clave || []).length ? `<p>${m.palabras_clave.map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</p>` : ''}
    <h3>Cómo acceder a estos datos</h3>
    ${servicios ? `<ul>${servicios}</ul>` : '<p class="muted">Aún no hay servicios disponibles para este recurso.</p>'}
    <h3>Diccionario de datos</h3>
    ${diccionario || '<p class="muted">El recurso aún no tiene diccionario de datos publicado.</p>'}
    <h3>Documentación técnica</h3>
    <p>
      ${m.id ? `<a href="/api/v1/publico/metadatos/${m.id}/xml" target="_blank" rel="noopener">Ficha de metadatos (ISO 19139 · XML)</a>` : ''}
      ${(f.diccionario || []).length ? ` · <a href="/api/v1/publico/catalogo-objetos/${tipo}/${id}/xml" target="_blank" rel="noopener">Catálogo de objetos (ISO 19110 · XML)</a>` : ''}
      ${!m.id && !(f.diccionario || []).length ? '<span class="muted">Sin documentación técnica publicada.</span>' : ''}
    </p>`;
  $('#detalle').scrollIntoView({ behavior: 'smooth' });
}

$('#buscar').addEventListener('click', buscar);
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') buscar(); });
function abrirCard(card) {
  verFicha(card.dataset.tipo, card.dataset.id).catch((err) => alert(err.message));
}
$('#resultados').addEventListener('click', (e) => {
  const card = e.target.closest('.card-recurso');
  if (card) abrirCard(card);
});
$('#resultados').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.card-recurso');
  if (card) { e.preventDefault(); abrirCard(card); }
});

buscar().catch((err) => { $('#resultados').innerHTML = `<p class="muted">${esc(err.message)}</p>`; });
