import { makeStore } from './db.js';
import { CONFIG } from './config.js';

const store = makeStore();
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400000;
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const parseDay = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const daysSince = s => Math.floor((parseDay(todayISO()) - parseDay(s)) / DAY);
const fmtDate = s => parseDay(s).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
const fmtDateTime = s => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const num = v => (v === '' || v == null || isNaN(+v) ? null : +v);
const fmt1 = v => (v == null ? '–' : (+v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }));

const DEFAULT_SPECIES = [
  { name: 'Alface', emoji: '🥬', ph_min: 5.5, ph_max: 6.5, ec_min: 0.8, ec_max: 1.2, days_to_harvest: 40, continuous: false },
  { name: 'Morango', emoji: '🍓', ph_min: 5.5, ph_max: 6.2, ec_min: 1.0, ec_max: 1.8, days_to_harvest: 80, continuous: true },
  { name: 'Salsinha', emoji: '🌿', ph_min: 5.5, ph_max: 6.5, ec_min: 0.8, ec_max: 1.8, days_to_harvest: 60, continuous: true },
  { name: 'Cebolinha', emoji: '🧅', ph_min: 6.0, ph_max: 6.7, ec_min: 1.4, ec_max: 1.8, days_to_harvest: 60, continuous: true },
];
const DEFAULT_SETTINGS = { layout: [4, 5, 5, 6], ph_every_days: 2, change_every_days: 14, reservoir_liters: 50, ph_down_ml_per_l: 0.3, ph_up_ml_per_l: 0.3, notify_enabled: true, notify_hour: 8 };
const UNITS = { g: 'g', un: 'unid.', maco: 'maço(s)', pe: 'pé(s)' };
const EVENT_KINDS = {
  troca: { label: 'Troca da solução', ico: '🔄' },
  completar: { label: 'Completei água', ico: '🚰' },
  nutriente: { label: 'Adicionei nutriente', ico: '🧪' },
  ajuste_ph: { label: 'Corrigi o pH', ico: '⚗️' },
  colheita: { label: 'Colheita', ico: '🧺' },
  outro: { label: 'Outro', ico: '📝' },
};

const S = { tab: 'hoje', species: [], plantings: [], photos: [], readings: [], events: [], harvests: [], settings: null };

// ---------- Dados ----------
async function loadAll() {
  const [species, plantings, photos, readings, events, settings, harvests] = await Promise.all(
    ['species', 'plantings', 'photos', 'readings', 'events', 'settings', 'harvests'].map(t => store.list(t)));
  S.harvests = harvests.sort((a, b) => b.harvested_on.localeCompare(a.harvested_on) || (b.created_at || '').localeCompare(a.created_at || ''));
  S.species = species.sort((a, b) => a.name.localeCompare(b.name));
  S.plantings = plantings;
  S.photos = photos.sort((a, b) => (b.taken_on || '').localeCompare(a.taken_on || '') || (b.created_at || '').localeCompare(a.created_at || ''));
  S.readings = readings.sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  S.events = events.sort((a, b) => b.happened_on.localeCompare(a.happened_on));
  S.settingsRow = settings[0] || null;
  S.settings = { ...DEFAULT_SETTINGS, ...(settings[0] || {}) };
  if (!S.species.length) {
    for (const sp of DEFAULT_SPECIES) S.species.push(await store.insert('species', sp));
    S.species.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (!S.settingsRow) S.settingsRow = await store.insert('settings', DEFAULT_SETTINGS);
}
const spById = id => S.species.find(s => s.id === id);
const active = () => S.plantings.filter(p => !p.harvested_on);
const plantAt = (tube, hole) => active().find(p => p.tube === tube && p.hole === hole);

function targetPh() {
  const sps = [...new Set(active().map(p => p.species_id))].map(spById).filter(Boolean);
  if (!sps.length) return { min: 5.5, max: 6.5, conflict: false, empty: true };
  const min = Math.max(...sps.map(s => +s.ph_min)), max = Math.min(...sps.map(s => +s.ph_max));
  if (min <= max) return { min, max, conflict: false };
  return { min: Math.min(...sps.map(s => +s.ph_min)), max: Math.max(...sps.map(s => +s.ph_max)), conflict: true };
}
function targetEc() {
  const sps = [...new Set(active().map(p => p.species_id))].map(spById).filter(s => s && s.ec_min != null);
  if (!sps.length) return null;
  const min = Math.max(...sps.map(s => +s.ec_min)), max = Math.min(...sps.map(s => +s.ec_max));
  return min <= max ? { min, max } : { min: Math.min(...sps.map(s => +s.ec_min)), max: Math.max(...sps.map(s => +s.ec_max)), conflict: true };
}
function phStatus(ph, t = targetPh()) {
  if (ph == null) return { cls: '', txt: 'sem leitura' };
  if (ph >= t.min && ph <= t.max) return { cls: 'ok', txt: 'no alvo' };
  const off = ph < t.min ? t.min - ph : ph - t.max;
  return { cls: off > 0.4 ? 'bad' : 'warn', txt: ph < t.min ? 'baixo' : 'alto' };
}
function harvestInfo(p) {
  const sp = spById(p.species_id); const age = daysSince(p.planted_on);
  const total = +sp?.days_to_harvest || 0;
  const lastCut = p.last_harvest_on ? daysSince(p.last_harvest_on) : null;
  const left = total ? total - age : null;
  const ready = total && age >= total && (!sp?.continuous || lastCut == null || lastCut >= 14);
  return { sp, age, total, left, ready, pct: total ? Math.min(100, Math.round(age / total * 100)) : 0 };
}

function reminders() {
  const out = [];
  const lastR = S.readings.filter(r => r.ph != null).at(-1);
  const phDays = lastR ? daysSince(lastR.measured_at) : null;
  if (phDays == null) out.push({ ico: '⚗️', title: 'Meça o pH da água', sub: 'Ainda não há nenhuma medição registrada.', act: 'ph', lvl: 'warn' });
  else if (phDays >= S.settings.ph_every_days) out.push({ ico: '⚗️', title: 'Hora de medir o pH', sub: `Última medição há ${phDays} dia${phDays > 1 ? 's' : ''}.`, act: 'ph', lvl: 'warn' });
  if (lastR) {
    const st = phStatus(+lastR.ph);
    if (st.cls === 'warn' || st.cls === 'bad') {
      const t = targetPh();
      out.push({ ico: st.txt === 'baixo' ? '⬆️' : '⬇️', title: `pH ${st.txt} (${fmt1(lastR.ph)})`, sub: `Ajuste para ${fmt1(t.min)}–${fmt1(t.max)} com ${st.txt === 'baixo' ? 'pH up (alcalinizante)' : 'pH down (acidificante)'}, aos poucos, e meça de novo depois de 30 min.`, act: 'calc', lvl: st.cls });
    }
  }
  const lastChange = S.events.find(e => e.kind === 'troca');
  if (!lastChange) out.push({ ico: '🔄', title: 'Registre a última troca da solução', sub: `Assim eu aviso quando trocar de novo (a cada ${S.settings.change_every_days} dias).`, act: 'troca', lvl: '' });
  else {
    const d = daysSince(lastChange.happened_on), left = S.settings.change_every_days - d;
    if (left <= 0) out.push({ ico: '🔄', title: 'Trocar a solução nutritiva', sub: `Última troca há ${d} dias.`, act: 'troca', lvl: left < -3 ? 'bad' : 'warn' });
    else if (left <= 2) out.push({ ico: '🔄', title: `Troca da solução em ${left} dia${left > 1 ? 's' : ''}`, sub: `Última troca em ${fmtDate(lastChange.happened_on)}.`, lvl: '' });
  }
  for (const p of active()) {
    const h = harvestInfo(p);
    if (!h.sp || !h.total) continue;
    if (h.ready) out.push({ ico: h.sp.emoji, title: `${h.sp.name} pronta para colher`, sub: `Tubo ${p.tube}, furo ${p.hole} · ${h.age} dias`, plant: p.id, lvl: 'ok' });
    else if (h.left > 0 && h.left <= 5) out.push({ ico: h.sp.emoji, title: `${h.sp.name}: colheita em ~${h.left} dia${h.left > 1 ? 's' : ''}`, sub: `Tubo ${p.tube}, furo ${p.hole}`, plant: p.id, lvl: '' });
  }
  const lastPhoto = S.photos[0];
  if (active().length && (!lastPhoto || daysSince(lastPhoto.taken_on) >= 7))
    out.push({ ico: '📷', title: 'Foto da semana', sub: 'Tire uma foto das plantas para acompanhar o crescimento.', act: 'foto', lvl: '' });
  return out;
}

// ---------- UI comum ----------
function toast(msg) {
  document.querySelectorAll('.toast').forEach(x => x.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
function sheet(html, onMount) {
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
  const close = () => scrim.remove();
  document.body.appendChild(scrim);
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  onMount?.(scrim.firstElementChild, close);
  return close;
}
async function busy(btn, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = 'Salvando…';
  try { await fn(); } catch (e) { console.error(e); toast('Erro: ' + (e.message || e)); btn.disabled = false; btn.textContent = old; throw e; }
}
async function imgTags(root = document) {
  for (const img of root.querySelectorAll('img[data-path]')) {
    if (img.src) continue;
    store.photoUrl(img.dataset.path).then(u => { if (u) img.src = u; });
  }
}

async function compress(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const src = bmp || await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 1600, w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
}

// ---------- Telas ----------
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === S.tab ? 'page' : 'false'));
  const m = $('#main');
  m.innerHTML = { hoje: viewHoje, horta: viewHorta, agua: viewAgua, fotos: viewFotos }[S.tab]();
  bind(m); imgTags(m);
}

function viewHoje() {
  const t = targetPh(); const lastR = S.readings.filter(r => r.ph != null).at(-1);
  const st = phStatus(lastR ? +lastR.ph : null, t);
  const lastChange = S.events.find(e => e.kind === 'troca');
  const rems = reminders();
  const counts = {};
  for (const p of active()) { const sp = spById(p.species_id); if (sp) counts[sp.id] = (counts[sp.id] || 0) + 1; }
  const total = S.settings.layout.reduce((a, b) => a + b, 0);
  return `
  <img class="banner" src="banner.jpg" alt="Horta do Joaquim, cultivo hidropônico">
  <div class="grid2">
    <div class="card" style="margin:0">
      <div class="muted small">pH da água</div>
      <div class="big">${lastR ? fmt1(lastR.ph) : '–'}</div>
      <div class="row" style="margin-top:4px"><span class="pill ${st.cls}">${st.txt}</span></div>
      <div class="muted small" style="margin-top:6px">${lastR ? fmtDateTime(lastR.measured_at) : 'nenhuma medição'}</div>
    </div>
    <div class="card" style="margin:0">
      <div class="muted small">Solução trocada</div>
      <div class="big">${lastChange ? daysSince(lastChange.happened_on) : '–'}<span class="small muted" style="font-weight:400"> ${lastChange ? 'dias atrás' : ''}</span></div>
      <div class="muted small" style="margin-top:6px">troca a cada ${S.settings.change_every_days} dias</div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="row"><div class="grow"><b>pH alvo: ${fmt1(t.min)} a ${fmt1(t.max)}</b>
      <div class="muted small">${t.empty ? 'Faixa geral. Fica mais precisa quando você cadastrar as plantas.' : t.conflict ? 'As plantas atuais pedem faixas diferentes; use o meio da faixa.' : 'Faixa que atende todas as plantas da horta agora.'}</div></div></div>
  </div>
  <div class="row" style="margin-bottom:14px">
    <button class="btn primary grow" data-act="ph">⚗️ Registrar pH</button>
    <button class="btn grow" data-act="evento">🔄 Registrar cuidado</button>
  </div>
  <div class="card"><h2>Lembretes</h2>
    ${rems.length ? rems.map(r => `<div class="reminder"><div class="ico">${r.ico}</div><div class="grow"><b>${esc(r.title)}</b> ${r.lvl ? `<span class="pill ${r.lvl}">${r.lvl === 'ok' ? 'agora' : r.lvl === 'bad' ? 'atrasado' : 'pendente'}</span>` : ''}<div class="muted small">${esc(r.sub)}</div></div>
      ${r.act ? `<button class="btn" data-act="${r.act}">${{ ph: 'Medir', troca: 'Feito', foto: 'Foto', calc: 'Calcular' }[r.act]}</button>` : r.plant ? `<button class="btn" data-plant="${r.plant}">Ver</button>` : ''}</div>`).join('')
      : '<div class="muted">Tudo em dia. 🌿</div>'}
  </div>
  <div class="card"><h2>Na horta</h2>
    <div class="muted small" style="margin-bottom:8px">${active().length} de ${total} furos ocupados</div>
    <div class="legend">${Object.entries(counts).map(([id, n]) => `<span>${spById(id).emoji} ${esc(spById(id).name)}: <b>${n}</b></span>`).join('') || 'Nenhuma planta cadastrada. Toque em <b>Horta</b> e depois num furo.'}</div>
  </div>
  ${placarCard()}`;
}

function viewHorta() {
  const lay = S.settings.layout;
  return `
  <div class="card">
    <div class="muted small">Toque num furo para plantar ou ver a planta. O tubo 1 é o de cima.</div>
    <div class="garden">
    ${lay.map((n, ti) => `<div class="tube"><div class="tube-label">Tubo ${ti + 1}</div><div class="pipe">
      ${Array.from({ length: n }, (_, hi) => { const p = plantAt(ti + 1, hi + 1); const sp = p && spById(p.species_id); const h = p && harvestInfo(p);
        return p ? `<button class="hole" data-hole="${ti + 1}:${hi + 1}" aria-label="Tubo ${ti + 1} furo ${hi + 1}: ${esc(sp?.name)}">${sp?.emoji || '🌱'}${h.ready ? '<i class="ready"></i>' : ''}<span class="n">${hi + 1}</span></button>`
                 : `<button class="hole empty" data-hole="${ti + 1}:${hi + 1}" aria-label="Tubo ${ti + 1} furo ${hi + 1}: vazio">+<span class="n">${hi + 1}</span></button>`; }).join('')}
    </div></div>`).join('')}
    </div>
    <div class="legend"><span><i class="swatch" style="background:var(--warn);border-radius:50%"></i> pronta para colher</span></div>
  </div>
  <div class="card"><h2>Plantas</h2><div class="list">
    ${active().sort((a, b) => a.tube - b.tube || a.hole - b.hole).map(p => { const h = harvestInfo(p);
      return `<div data-plant="${p.id}" style="cursor:pointer"><span style="font-size:24px">${h.sp?.emoji || '🌱'}</span><div class="grow"><b>${esc(h.sp?.name)}</b> <span class="muted small">T${p.tube}·F${p.hole}</span>
      <div class="progress"><i style="width:${h.pct}%"></i></div><div class="muted small">${h.age} dias${h.total ? ` · ${h.ready ? 'pronta' : `colheita em ~${h.left} dias`}` : ''}</div></div></div>`; }).join('') || '<div class="muted">Nenhuma planta ainda.</div>'}
  </div></div>
  ${S.plantings.some(p => p.harvested_on) ? `<div class="card"><h2>Já colhidas</h2><div class="list">${S.plantings.filter(p => p.harvested_on).sort((a, b) => b.harvested_on.localeCompare(a.harvested_on)).slice(0, 20).map(p => { const sp = spById(p.species_id);
      return `<div data-plant="${p.id}" style="cursor:pointer"><span style="font-size:20px">${sp?.emoji || '🌱'}</span><div class="grow">${esc(sp?.name)} <span class="muted small">T${p.tube}·F${p.hole} · ${fmtDate(p.planted_on)} → ${fmtDate(p.harvested_on)} (${Math.round((parseDay(p.harvested_on) - parseDay(p.planted_on)) / DAY)} dias)</span></div></div>`; }).join('')}</div></div>` : ''}`;
}

function phChart() {
  const rs = S.readings.filter(r => r.ph != null).slice(-60);
  if (rs.length < 2) return `<div class="muted small">O gráfico aparece a partir de 2 medições.</div>`;
  const t = targetPh();
  const W = 340, H = 180, L = 30, R = 10, T = 10, B = 24;
  const xs = rs.map(r => new Date(r.measured_at).getTime());
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  const vals = rs.map(r => +r.ph);
  const y0 = Math.min(5, ...vals, t.min) - 0.2, y1 = Math.max(7, ...vals, t.max) + 0.2;
  const X = v => L + (W - L - R) * (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0));
  const Y = v => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  const ticks = []; for (let v = Math.ceil(y0 * 2) / 2; v <= y1; v += 0.5) ticks.push(v);
  const path = rs.map((r, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(+r.ph).toFixed(1)}`).join('');
  const xl = [rs[0], rs[Math.floor(rs.length / 2)], rs.at(-1)];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico do pH ao longo do tempo">
    <rect x="${L}" y="${Y(t.max)}" width="${W - L - R}" height="${Y(t.min) - Y(t.max)}" fill="var(--band)"/>
    ${ticks.map(v => `<line class="axis" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke-width="${Number.isInteger(v) ? 1 : .5}"/><text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(1).replace('.', ',')}</text>`).join('')}
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${rs.map((r, i) => { const s = phStatus(+r.ph, t); return `<circle cx="${X(xs[i])}" cy="${Y(+r.ph)}" r="${i === rs.length - 1 ? 4.5 : 3}" fill="var(--${s.cls || 'ok'})" stroke="var(--surface)" stroke-width="1.5"><title>${fmt1(r.ph)} em ${fmtDateTime(r.measured_at)}</title></circle>`; }).join('')}
    ${xl.map((r, i) => `<text x="${X(new Date(r.measured_at).getTime())}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${fmtDate(r.measured_at)}</text>`).join('')}
  </svg>
  <div class="legend" style="margin-top:6px"><span><i class="swatch" style="background:var(--band);border:1px solid var(--accent)"></i> faixa alvo ${fmt1(t.min)}–${fmt1(t.max)}</span></div>`;
}

function viewAgua() {
  const ec = targetEc();
  const items = [
    ...S.readings.map(r => ({ when: r.measured_at, html: `<span style="font-size:20px">⚗️</span><div class="grow"><b>pH ${fmt1(r.ph)}</b>${r.ec != null ? ` · EC ${fmt1(r.ec)}` : ''}${r.water_temp != null ? ` · ${fmt1(r.water_temp)} °C` : ''} <span class="pill ${phStatus(r.ph == null ? null : +r.ph).cls}">${phStatus(r.ph == null ? null : +r.ph).txt}</span><div class="muted small">${fmtDateTime(r.measured_at)}${r.note ? ' · ' + esc(r.note) : ''}</div></div><button class="btn" data-del-reading="${r.id}" aria-label="Apagar">🗑️</button>` })),
    ...S.events.map(e => ({ when: e.happened_on, html: `<span style="font-size:20px">${EVENT_KINDS[e.kind]?.ico || '📝'}</span><div class="grow"><b>${EVENT_KINDS[e.kind]?.label || e.kind}</b><div class="muted small">${fmtDate(e.happened_on)}${e.note ? ' · ' + esc(e.note) : ''}</div></div><button class="btn" data-del-event="${e.id}" aria-label="Apagar">🗑️</button>` })),
  ].sort((a, b) => String(b.when).localeCompare(String(a.when)));
  return `
  <div class="row" style="margin-bottom:10px">
    <button class="btn primary grow" data-act="ph">⚗️ Nova medição</button>
    <button class="btn grow" data-act="evento">🔄 Registrar cuidado</button>
  </div>
  <button class="btn block" data-act="calc" style="margin-bottom:14px">🧮 Calculadora de correção do pH</button>
  <div class="card chart"><h2>pH ao longo do tempo</h2>${phChart()}</div>
  ${ec ? `<div class="card small"><b>EC alvo para as plantas atuais:</b> ${fmt1(ec.min)} a ${fmt1(ec.max)} mS/cm. <span class="muted">Quando o medidor chegar, é só preencher o campo EC na medição.</span></div>` : ''}
  <div class="card"><h2>Histórico</h2><div class="list">${items.slice(0, 80).map(i => `<div>${i.html}</div>`).join('') || '<div class="muted">Nada registrado ainda.</div>'}</div></div>`;
}

function viewFotos() {
  return `
  <div class="row" style="margin-bottom:14px"><button class="btn primary grow" data-act="foto">📷 Nova foto</button></div>
  ${S.photos.length ? `<div class="photos">${S.photos.map(f => { const p = S.plantings.find(x => x.id === f.planting_id); const sp = p && spById(p.species_id);
    return `<figure data-photo="${f.id}"><img data-path="${esc(f.path)}" alt="" loading="lazy"><figcaption>${fmtDate(f.taken_on)}${sp ? ' · ' + sp.emoji + ' T' + p.tube + 'F' + p.hole : ' · horta'}</figcaption></figure>`; }).join('')}</div>`
    : '<div class="card empty-state">Nenhuma foto ainda. Tire uma da horta toda ou de uma planta específica (pelo furo na aba Horta).</div>'}`;
}

// ---------- Ações ----------
function bind(root) {
  root.querySelectorAll('[data-act]').forEach(b => b.onclick = () => ({ ph: formReading, troca: () => formEvent('troca'), evento: () => formEvent(), foto: () => formPhoto(), calc: () => formCalc(), placar: () => showHarvests() }[b.dataset.act])());
  root.querySelectorAll('[data-hole]').forEach(b => b.onclick = () => { const [t, h] = b.dataset.hole.split(':').map(Number); const p = plantAt(t, h); p ? showPlant(p.id) : formPlant(t, h); });
  root.querySelectorAll('[data-plant]').forEach(b => b.onclick = () => showPlant(b.dataset.plant));
  root.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => viewPhoto(b.dataset.photo));
  root.querySelectorAll('[data-del-reading]').forEach(b => b.onclick = async () => { if (!confirm('Apagar esta medição?')) return; await store.remove('readings', b.dataset.delReading); S.readings = S.readings.filter(r => r.id !== b.dataset.delReading); render(); });
  root.querySelectorAll('[data-del-event]').forEach(b => b.onclick = async () => { if (!confirm('Apagar este registro?')) return; await store.remove('events', b.dataset.delEvent); S.events = S.events.filter(r => r.id !== b.dataset.delEvent); render(); });
}

function formReading() {
  const t = targetPh();
  sheet(`<h3>Nova medição</h3><div class="muted small">Alvo agora: pH ${fmt1(t.min)}–${fmt1(t.max)}</div>
    <form><div class="grid2"><div><label>pH *</label><input name="ph" type="number" step="0.1" min="0" max="14" inputmode="decimal" required autofocus></div>
    <div><label>EC (mS/cm)</label><input name="ec" type="number" step="0.1" min="0" inputmode="decimal" placeholder="opcional"></div></div>
    <div class="grid2"><div><label>Temp. da água (°C)</label><input name="water_temp" type="number" step="0.5" inputmode="decimal" placeholder="opcional"></div>
    <div><label>Quando</label><input name="measured_at" type="datetime-local" value="${nowLocal()}"></div></div>
    <label>Observação</label><input name="note" placeholder="ex.: depois de corrigir">
    <div class="actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar</button></div></form>`,
    (el, close) => { const f = $('form', el); f.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f));
      busy($('.primary', f), async () => {
        const r = await store.insert('readings', { ph: num(d.ph), ec: num(d.ec), water_temp: num(d.water_temp), measured_at: new Date(d.measured_at).toISOString(), note: d.note || null });
        S.readings.push(r); S.readings.sort((a, b) => a.measured_at.localeCompare(b.measured_at)); close(); render();
        const st = phStatus(r.ph); toast(st.cls === 'ok' ? 'pH no alvo 👍' : `pH ${st.txt}. Veja a dica em Hoje.`);
      }); }; });
}

function formEvent(kind) {
  sheet(`<h3>Registrar cuidado</h3><form>
    <label>O que você fez</label><select name="kind">${Object.entries(EVENT_KINDS).map(([k, v]) => `<option value="${k}" ${k === (kind || 'troca') ? 'selected' : ''}>${v.ico} ${v.label}</option>`).join('')}</select>
    <label>Data</label><input name="happened_on" type="date" value="${todayISO()}" max="${todayISO()}">
    <label>Observação</label><input name="note" placeholder="ex.: 20 L, 40 ml de A + 40 ml de B">
    <div class="actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar</button></div></form>`,
    (el, close) => { const f = $('form', el); f.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f));
      busy($('.primary', f), async () => { const r = await store.insert('events', { kind: d.kind, happened_on: d.happened_on, note: d.note || null });
        S.events.unshift(r); S.events.sort((a, b) => b.happened_on.localeCompare(a.happened_on)); close(); render(); toast('Registrado'); }); }; });
}

function formPlant(tube, hole, existing) {
  const p = existing || {};
  sheet(`<h3>${existing ? 'Editar planta' : 'Plantar'} · Tubo ${tube}, furo ${hole}</h3><form>
    <label>Planta</label><select name="species_id" required>${S.species.map(s => `<option value="${s.id}" ${s.id === p.species_id ? 'selected' : ''}>${s.emoji} ${esc(s.name)}</option>`).join('')}</select>
    <label>Data em que foi para o tubo</label><input name="planted_on" type="date" value="${p.planted_on || todayISO()}" max="${todayISO()}">
    <label>Observação</label><input name="notes" value="${esc(p.notes || '')}" placeholder="ex.: muda comprada, semente própria">
    <div class="actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar</button></div></form>`,
    (el, close) => { const f = $('form', el); f.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f));
      busy($('.primary', f), async () => {
        const row = { tube, hole, species_id: d.species_id, planted_on: d.planted_on, notes: d.notes || null };
        if (existing) { const r = await store.update('plantings', existing.id, row); Object.assign(existing, r); }
        else S.plantings.push(await store.insert('plantings', row));
        close(); render(); }); }; });
}

function showPlant(id) {
  const p = S.plantings.find(x => x.id === id); if (!p) return;
  const h = harvestInfo(p); const sp = h.sp;
  const photos = S.photos.filter(f => f.planting_id === id).sort((a, b) => a.taken_on.localeCompare(b.taken_on));
  sheet(`<div class="row"><span style="font-size:40px">${sp?.emoji || '🌱'}</span><div class="grow"><h3>${esc(sp?.name)}</h3>
      <div class="muted small">Tubo ${p.tube}, furo ${p.hole} · plantada em ${fmtDate(p.planted_on)}${p.harvested_on ? ` · colhida em ${fmtDate(p.harvested_on)}` : ''}</div></div></div>
    ${!p.harvested_on && h.total ? `<div style="margin-top:12px"><div class="row small"><span class="grow">${h.age} dias</span><span class="muted">${h.ready ? 'pronta para colher' : `colheita em ~${h.left} dias`}</span></div><div class="progress"><i style="width:${h.pct}%"></i></div></div>` : ''}
    ${p.last_harvest_on ? `<div class="muted small">Último corte/colheita: ${fmtDate(p.last_harvest_on)}</div>` : ''}
    ${p.notes ? `<p class="small">${esc(p.notes)}</p>` : ''}
    <h3 style="margin-top:16px;font-size:15px">Linha do tempo (${photos.length} foto${photos.length === 1 ? '' : 's'})</h3>
    ${photos.length ? `<div class="timeline">${photos.map(f => `<figure><img data-path="${esc(f.path)}" data-photo="${f.id}" alt=""><figcaption>${fmtDate(f.taken_on)} · dia ${Math.max(0, Math.round((parseDay(f.taken_on) - parseDay(p.planted_on)) / DAY))}</figcaption></figure>`).join('')}</div>` : '<div class="muted small">Nenhuma foto desta planta ainda.</div>'}
    <div class="actions"><button class="btn primary" data-a="foto">📷 Foto</button>${!p.harvested_on ? `<button class="btn" data-a="colher">🧺 Colher</button>` : ''}</div>
    <div class="actions" style="margin-top:8px"><button class="btn" data-a="editar">Editar</button><button class="btn danger" data-a="apagar">Apagar</button><button class="btn" data-close>Fechar</button></div>`,
    (el, close) => {
      imgTags(el);
      el.querySelectorAll('[data-photo]').forEach(i => i.onclick = () => viewPhoto(i.dataset.photo));
      $('[data-a=foto]', el).onclick = () => { close(); formPhoto(id); };
      $('[data-a=editar]', el).onclick = () => { close(); formPlant(p.tube, p.hole, p); };
      $('[data-a=apagar]', el).onclick = async () => { if (!confirm('Apagar esta planta e o histórico dela? As fotos continuam na aba Fotos.')) return;
        await store.remove('plantings', id); S.plantings = S.plantings.filter(x => x.id !== id); close(); render(); };
      const c = $('[data-a=colher]', el); if (c) c.onclick = () => { close(); formHarvest(p); };
    });
}

function formHarvest(p) {
  const sp = spById(p.species_id);
  const lastUnit = S.harvests.find(h => h.species_id === p.species_id)?.unit || (/morango/i.test(sp?.name || '') ? 'un' : 'g');
  sheet(`<h3>Colher ${sp?.emoji || ''} ${esc(sp?.name)}</h3><div class="muted small">Tubo ${p.tube}, furo ${p.hole}</div><form>
    <div class="grid2"><div><label>Quanto colheu</label><input name="qty" type="number" step="any" min="0" inputmode="decimal" placeholder="ex.: 250" autofocus></div>
    <div><label>Unidade</label><select name="unit">${Object.entries(UNITS).map(([k, v]) => `<option value="${k}" ${k === lastUnit ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
    <label>Data</label><input name="date" type="date" value="${todayISO()}" max="${todayISO()}">
    <label>Como foi</label><select name="how">
      <option value="parcial" ${sp?.continuous ? 'selected' : ''}>Colhi uma parte, a planta continua</option>
      <option value="final" ${sp?.continuous ? '' : 'selected'}>Colhi tudo, o furo fica vazio</option></select>
    <label>Observação</label><input name="note" placeholder="opcional">
    <div class="actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar</button></div></form>`,
    (el, close) => { const f = $('form', el); f.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f));
      busy($('.primary', f), async () => {
        const fin = d.how === 'final';
        const patch = fin ? { harvested_on: d.date, last_harvest_on: d.date } : { last_harvest_on: d.date };
        Object.assign(p, await store.update('plantings', p.id, patch));
        const h = await store.insert('harvests', { planting_id: p.id, species_id: p.species_id, harvested_on: d.date, qty: num(d.qty), unit: d.unit, final: fin, note: d.note || null });
        S.harvests.unshift(h); S.harvests.sort((a, b) => b.harvested_on.localeCompare(a.harvested_on));
        close(); render(); toast(`Bom proveito! 🧺${h.qty ? ' +' + fmtQty(h.qty, h.unit) : ''}`); }); }; });
}

// ---------- Colheitas e placar ----------
const fmtQty = (q, u) => q == null ? '' : u === 'g' && q >= 1000 ? `${(q / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kg` : `${(+q).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${UNITS[u] || u || ''}`.trim();
function placar(list = S.harvests) {
  const by = new Map();
  for (const h of list) {
    const k = h.species_id || 'x';
    const r = by.get(k) || { sp: spById(h.species_id), n: 0, tot: {} };
    r.n++; if (h.qty != null) r.tot[h.unit || 'un'] = (r.tot[h.unit || 'un'] || 0) + +h.qty;
    by.set(k, r);
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}
function placarRows(rows) {
  const medal = ['🥇', '🥈', '🥉'];
  return rows.map((r, i) => `<div><span style="font-size:22px">${r.sp?.emoji || '🌱'}</span><div class="grow"><b>${esc(r.sp?.name || 'Outra')}</b> <span class="muted small">${r.n} colheita${r.n > 1 ? 's' : ''}</span>
    <div class="small">${Object.entries(r.tot).map(([u, q]) => fmtQty(q, u)).join(' + ') || '<span class="muted">sem quantidade anotada</span>'}</div></div><span style="font-size:20px">${medal[i] || ''}</span></div>`).join('');
}
function placarCard() {
  const month = todayISO().slice(0, 7);
  const mes = S.harvests.filter(h => h.harvested_on.startsWith(month));
  return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">🏆 Placar da horta</h2><button class="btn" data-act="placar" style="min-height:36px;padding:6px 12px">Ver tudo</button></div>
    ${S.harvests.length ? `<div class="grid2" style="margin:10px 0 4px"><div><div class="big" style="font-size:28px">${S.harvests.length}</div><div class="muted small">colheitas no total</div></div><div><div class="big" style="font-size:28px">${mes.length}</div><div class="muted small">neste mês</div></div></div>
    <div class="list">${placarRows(placar().slice(0, 4))}</div>`
    : `<div class="muted small" style="margin-top:8px">Quando colher, toque na planta (aba Horta) e em <b>Colher</b>. As colheitas entram aqui.</div>`}</div>`;
}
function showHarvests() {
  const month = todayISO().slice(0, 7);
  sheet(`<h3>🏆 Placar da horta</h3>
    <div class="muted small">Neste mês</div><div class="list">${placarRows(placar(S.harvests.filter(h => h.harvested_on.startsWith(month)))) || '<div class="muted small">Nenhuma colheita neste mês.</div>'}</div>
    <div class="muted small" style="margin-top:12px">Desde o começo</div><div class="list">${placarRows(placar()) || '<div class="muted small">Nenhuma colheita ainda.</div>'}</div>
    <h3 style="margin-top:16px;font-size:15px">Todas as colheitas</h3>
    <div class="list">${S.harvests.map(h => { const sp = spById(h.species_id); const p = S.plantings.find(x => x.id === h.planting_id);
      return `<div><span style="font-size:20px">${sp?.emoji || '🌱'}</span><div class="grow"><b>${esc(sp?.name)}</b> ${h.qty != null ? '· ' + fmtQty(h.qty, h.unit) : ''}<div class="muted small">${fmtDate(h.harvested_on)}${p ? ` · T${p.tube}F${p.hole}` : ''}${h.final ? ' · colheita final' : ''}${h.note ? ' · ' + esc(h.note) : ''}</div></div><button class="btn" data-del-h="${h.id}" aria-label="Apagar">🗑️</button></div>`; }).join('') || '<div class="muted small">Nada ainda.</div>'}</div>
    <div class="actions"><button class="btn" data-close>Fechar</button></div>`,
    (el, close) => el.querySelectorAll('[data-del-h]').forEach(b => b.onclick = async () => { if (!confirm('Apagar esta colheita do placar?')) return;
      await store.remove('harvests', b.dataset.delH); S.harvests = S.harvests.filter(x => x.id !== b.dataset.delH); close(); render(); showHarvests(); }));
}

// ---------- Calculadora de pH ----------
function formCalc() {
  const t = targetPh(); const lastR = S.readings.filter(r => r.ph != null).at(-1);
  const alvo = Math.round(((t.min + t.max) / 2) * 10) / 10;
  sheet(`<h3>🧮 Correção do pH</h3><div class="muted small">Estimativa. Coloque metade da dose, misture, espere 30 min e meça de novo.</div><form>
    <div class="grid2"><div><label>pH agora</label><input name="atual" type="number" step="0.1" inputmode="decimal" value="${lastR ? lastR.ph : ''}" required></div>
    <div><label>pH desejado</label><input name="alvo" type="number" step="0.1" inputmode="decimal" value="${alvo}" required></div></div>
    <label>Água na caixa (litros)</label><input name="litros" type="number" step="any" min="1" inputmode="decimal" value="${S.settings.reservoir_liters}" required>
    <div id="res" class="card" style="margin:14px 0 0;background:var(--surface-2)"></div>
    <details style="margin-top:12px"><summary class="small" style="cursor:pointer">Ajustar a força do produto (calibrar)</summary>
      <div class="muted small" style="margin-top:6px">Quanto do produto, em ml por litro de água, muda o pH em 1 ponto. Cada marca é diferente. O jeito mais fácil é calibrar com uma correção que você já fez:</div>
      <div class="grid2"><div><label>pH down (ml/L por ponto)</label><input name="fd" type="number" step="any" value="${S.settings.ph_down_ml_per_l}"></div><div><label>pH up (ml/L por ponto)</label><input name="fu" type="number" step="any" value="${S.settings.ph_up_ml_per_l}"></div></div>
      <div class="grid2"><div><label>Usei (ml)</label><input name="cml" type="number" step="any" inputmode="decimal"></div><div><label>Produto</label><select name="cprod"><option value="down">pH down</option><option value="up">pH up</option></select></div></div>
      <div class="grid2"><div><label>pH antes</label><input name="cantes" type="number" step="0.1" inputmode="decimal"></div><div><label>pH depois</label><input name="cdepois" type="number" step="0.1" inputmode="decimal"></div></div>
      <button type="button" class="btn block" data-a="calib" style="margin-top:10px">Calcular força a partir disso</button>
    </details>
    <div class="actions"><button type="button" class="btn" data-close>Fechar</button><button class="btn primary" data-a="reg">Registrar correção</button></div></form>`,
    (el, close) => {
      const f = $('form', el); let last = null;
      const calc = () => {
        const a = num(f.atual.value), b = num(f.alvo.value), L = num(f.litros.value);
        const res = $('#res', el);
        if (a == null || b == null || !L) { res.innerHTML = '<span class="muted small">Preencha o pH e os litros.</span>'; last = null; return; }
        const delta = b - a;
        if (Math.abs(delta) < 0.05) { res.innerHTML = '<b>O pH já está no ponto. 👍</b>'; last = null; return; }
        const down = delta < 0, fator = num(down ? f.fd.value : f.fu.value) || 0.3;
        const ml = Math.abs(delta) * L * fator, gotas = Math.round(ml * 20);
        last = { prod: down ? 'pH down' : 'pH up', ml };
        res.innerHTML = `<div class="muted small">Para ${down ? 'baixar' : 'subir'} de ${fmt1(a)} para ${fmt1(b)} em ${fmt1(L)} L</div>
          <div class="big" style="font-size:28px;margin:4px 0">${ml < 10 ? ml.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : Math.round(ml)} ml <span class="small muted" style="font-weight:400">de ${last.prod}</span></div>
          <div class="small">≈ ${gotas} gotas. Comece com <b>${(ml / 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ml</b> (metade) e meça de novo em 30 min.</div>`;
      };
      f.oninput = calc; calc();
      $('[data-a=calib]', el).onclick = async () => {
        const ml = num(f.cml.value), x = num(f.cantes.value), y = num(f.cdepois.value), L = num(f.litros.value);
        if (!ml || x == null || y == null || !L || Math.abs(x - y) < 0.05) return toast('Preencha ml usados, pH antes e depois, e os litros.');
        const fator = Math.round(ml / (Math.abs(x - y) * L) * 1000) / 1000;
        const key = f.cprod.value === 'up' ? 'ph_up_ml_per_l' : 'ph_down_ml_per_l';
        f[f.cprod.value === 'up' ? 'fu' : 'fd'].value = fator;
        await store.update('settings', S.settingsRow.id, { [key]: fator }); S.settings[key] = fator; calc(); toast('Força do produto salva');
      };
      f.onsubmit = e => { e.preventDefault(); if (!last) return close();
        busy($('[data-a=reg]', f), async () => {
          const L = num(f.litros.value), fd = num(f.fd.value), fu = num(f.fu.value);
          const patch = {};
          if (L && L !== +S.settings.reservoir_liters) patch.reservoir_liters = L;
          if (fd && fd !== +S.settings.ph_down_ml_per_l) patch.ph_down_ml_per_l = fd;
          if (fu && fu !== +S.settings.ph_up_ml_per_l) patch.ph_up_ml_per_l = fu;
          if (Object.keys(patch).length) { await store.update('settings', S.settingsRow.id, patch); Object.assign(S.settings, patch); }
          const ml = prompt(`Quantos ml de ${last.prod} você colocou?`, (last.ml / 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
          if (ml == null) return close();
          const ev = await store.insert('events', { kind: 'ajuste_ph', happened_on: todayISO(), note: `${ml} ml de ${last.prod} (pH ${fmt1(num(f.atual.value))} → alvo ${fmt1(num(f.alvo.value))}, ${fmt1(L)} L)` });
          S.events.unshift(ev); close(); render(); toast('Correção registrada. Meça de novo em 30 min.');
        }); };
    });
}

function formPhoto(plantingId) {
  sheet(`<h3>Nova foto</h3><form>
    <label>Foto</label><input name="file" type="file" accept="image/*" capture="environment" required>
    <img id="prev" alt="" style="display:none;width:100%;max-height:240px;object-fit:contain;margin-top:8px;border-radius:10px;background:var(--surface-2)">
    <label>De qual planta</label><select name="planting_id"><option value="">Horta toda</option>${active().sort((a, b) => a.tube - b.tube || a.hole - b.hole).map(p => { const sp = spById(p.species_id); return `<option value="${p.id}" ${p.id === plantingId ? 'selected' : ''}>${sp?.emoji} ${esc(sp?.name)} · T${p.tube} F${p.hole}</option>`; }).join('')}</select>
    <div class="grid2"><div><label>Data</label><input name="taken_on" type="date" value="${todayISO()}" max="${todayISO()}"></div><div><label>Observação</label><input name="note" placeholder="opcional"></div></div>
    <div class="actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar</button></div></form>`,
    (el, close) => { const f = $('form', el);
      f.file.onchange = () => { const file = f.file.files[0]; if (file) { const i = $('#prev', el); i.src = URL.createObjectURL(file); i.style.display = 'block'; } };
      f.onsubmit = e => { e.preventDefault(); const file = f.file.files[0]; if (!file) return;
        busy($('.primary', f), async () => {
          const blob = await compress(file); const path = await store.uploadPhoto(blob);
          const r = await store.insert('photos', { planting_id: f.planting_id.value || null, taken_on: f.taken_on.value, note: f.note.value || null, path });
          S.photos.unshift(r); S.photos.sort((a, b) => b.taken_on.localeCompare(a.taken_on)); close(); render(); toast('Foto salva 📷'); }); }; });
}

async function viewPhoto(id) {
  const f = S.photos.find(x => x.id === id); if (!f) return;
  const p = S.plantings.find(x => x.id === f.planting_id); const sp = p && spById(p.species_id);
  const v = document.createElement('div'); v.className = 'viewer';
  v.innerHTML = `<img alt=""><div class="bar"><div class="grow small">${fmtDate(f.taken_on)}${sp ? ` · ${sp.emoji} ${esc(sp.name)} T${p.tube}F${p.hole}` : ' · horta'}${f.note ? '<br>' + esc(f.note) : ''}</div>
    <button class="btn danger" data-a="del">Apagar</button><button class="btn" data-a="x">Fechar</button></div>`;
  document.body.appendChild(v);
  $('img', v).src = await store.photoUrl(f.path);
  $('[data-a=x]', v).onclick = () => v.remove();
  $('[data-a=del]', v).onclick = async () => { if (!confirm('Apagar esta foto?')) return;
    await store.remove('photos', id); await store.removePhoto(f.path).catch(() => {}); S.photos = S.photos.filter(x => x.id !== id); v.remove(); document.querySelector('.scrim')?.remove(); render(); };
}

function showSettings() {
  sheet(`<h3>Ajustes</h3><form>
    <label>Furos em cada tubo (de cima para baixo, separados por vírgula)</label><input name="layout" value="${S.settings.layout.join(', ')}" inputmode="numeric">
    <div class="grid2"><div><label>Medir pH a cada (dias)</label><input name="ph_every_days" type="number" min="1" value="${S.settings.ph_every_days}"></div>
    <div><label>Trocar solução a cada (dias)</label><input name="change_every_days" type="number" min="1" value="${S.settings.change_every_days}"></div></div>
    <div class="grid2"><div><label>Água na caixa (litros)</label><input name="reservoir_liters" type="number" step="any" min="1" value="${S.settings.reservoir_liters}"></div>
    <div><label>Notificação diária às</label><select name="notify_hour">${Array.from({ length: 17 }, (_, i) => i + 6).map(h => `<option value="${h}" ${h === +S.settings.notify_hour ? 'selected' : ''}>${h}h</option>`).join('')}</select></div></div>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="notify_enabled" style="width:auto;min-height:0" ${S.settings.notify_enabled !== false ? 'checked' : ''}> Mandar os lembretes como notificação</label>
    <div class="actions"><button class="btn primary">Salvar ajustes</button></div></form>
    ${store.mode === 'cloud' ? `<h3 style="margin-top:20px;font-size:15px">🔔 Notificações neste celular</h3>
    <div class="muted small" id="push-st">Verificando…</div>
    <div class="actions"><button class="btn" data-a="push-on">Ativar neste celular</button><button class="btn" data-a="push-test">Enviar teste</button></div>` : ''}
    <h3 style="margin-top:20px;font-size:15px">Plantas e faixas ideais</h3>
    <div class="list">${S.species.map(s => `<div data-sp="${s.id}" style="cursor:pointer"><span style="font-size:22px">${s.emoji}</span><div class="grow"><b>${esc(s.name)}</b><div class="muted small">pH ${fmt1(s.ph_min)}–${fmt1(s.ph_max)} · EC ${fmt1(s.ec_min)}–${fmt1(s.ec_max)} · ${s.days_to_harvest} dias${s.continuous ? ' · colheita contínua' : ''}</div></div><span class="muted">›</span></div>`).join('')}</div>
    <button class="btn block" data-a="newsp" style="margin-top:8px">+ Nova espécie</button>
    <div class="actions"><button class="btn" data-a="export">Exportar dados</button>${store.mode === 'cloud' ? '<button class="btn danger" data-a="out">Sair</button>' : ''}</div>
    <div class="muted small" style="margin-top:10px">${store.mode === 'cloud' ? 'Dados salvos na nuvem (Supabase).' : 'Dados salvos só neste aparelho.'}</div>
    <div class="actions"><button class="btn" data-close>Fechar</button></div>`,
    (el, close) => {
      const f = $('form', el);
      f.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f));
        const layout = d.layout.split(/[,\s;]+/).map(Number).filter(n => n > 0 && n < 40);
        if (!layout.length) return toast('Informe os furos de cada tubo, ex.: 4, 5, 5, 6');
        busy($('.primary', f), async () => { const patch = { layout, ph_every_days: +d.ph_every_days || 2, change_every_days: +d.change_every_days || 14, reservoir_liters: num(d.reservoir_liters) || 50, notify_hour: +d.notify_hour, notify_enabled: !!d.notify_enabled };
          await store.update('settings', S.settingsRow.id, patch); Object.assign(S.settings, patch); close(); render(); toast('Ajustes salvos'); }); };
      el.querySelectorAll('[data-sp]').forEach(r => r.onclick = () => { close(); formSpecies(spById(r.dataset.sp)); });
      $('[data-a=newsp]', el).onclick = () => { close(); formSpecies(); };
      $('[data-a=export]', el).onclick = () => { const blob = new Blob([JSON.stringify({ exportado_em: new Date().toISOString(), ...S }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `horta-${todayISO()}.json`; a.click(); };
      const o = $('[data-a=out]', el); if (o) o.onclick = async () => { await store.signOut(); location.reload(); };
      const st = $('#push-st', el);
      if (st) {
        const upd = async () => { st.textContent = await pushStatus(); };
        upd();
        $('[data-a=push-on]', el).onclick = async e => { const b = e.target; b.disabled = true; try { await enablePush(); toast('Notificações ativadas 🔔'); } catch (err) { toast(err.message || String(err)); } b.disabled = false; upd(); };
        $('[data-a=push-test]', el).onclick = async e => { const b = e.target; b.disabled = true; try { const r = await store.testPush(); toast(r.ok ? 'Teste enviado. Deve chegar em segundos.' : 'Este celular ainda não está ativado.'); } catch (err) { toast('Erro: ' + (err.message || err)); } b.disabled = false; };
      }
    });
}

// ---------- Notificações ----------
async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'Este navegador não aceita notificações. No iPhone, instale o app na tela inicial primeiro.';
  if (Notification.permission === 'denied') return 'As notificações estão bloqueadas para este site. Libere nas configurações do navegador.';
  const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
  return sub ? `Ativadas neste celular. O resumo chega por volta das ${S.settings.notify_hour}h, quando houver algo a fazer.` : 'Ainda não ativadas neste celular.';
}
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Este navegador não aceita notificações.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permissão negada. Libere as notificações para este site.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(CONFIG.vapidPublic) });
  await store.savePush(sub.toJSON(), navigator.userAgent.slice(0, 120));
}
function b64ToU8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function formSpecies(s = {}) {
  sheet(`<h3>${s.id ? 'Editar' : 'Nova'} espécie</h3><form>
    <div class="grid2"><div><label>Nome</label><input name="name" value="${esc(s.name || '')}" required></div><div><label>Emoji</label><input name="emoji" value="${esc(s.emoji || '🌱')}" maxlength="4"></div></div>
    <div class="grid2"><div><label>pH mínimo</label><input name="ph_min" type="number" step="0.1" value="${s.ph_min ?? 5.5}"></div><div><label>pH máximo</label><input name="ph_max" type="number" step="0.1" value="${s.ph_max ?? 6.5}"></div></div>
    <div class="grid2"><div><label>EC mínima</label><input name="ec_min" type="number" step="0.1" value="${s.ec_min ?? 1.0}"></div><div><label>EC máxima</label><input name="ec_max" type="number" step="0.1" value="${s.ec_max ?? 1.6}"></div></div>
    <label>Dias até a (primeira) colheita</label><input name="days_to_harvest" type="number" min="1" value="${s.days_to_harvest ?? 45}">
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="continuous" style="width:auto;min-height:0" ${s.continuous ? 'checked' : ''}> Colheita contínua (corta e rebrota)</label>
    <div class="actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar</button></div></form>`,
    (el, close) => { const f = $('form', el); f.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f));
      const row = { name: d.name.trim(), emoji: d.emoji || '🌱', ph_min: num(d.ph_min), ph_max: num(d.ph_max), ec_min: num(d.ec_min), ec_max: num(d.ec_max), days_to_harvest: +d.days_to_harvest || null, continuous: !!d.continuous };
      busy($('.primary', f), async () => {
        if (s.id) Object.assign(s, await store.update('species', s.id, row)); else S.species.push(await store.insert('species', row));
        S.species.sort((a, b) => a.name.localeCompare(b.name)); close(); render(); }); }; });
}

// ---------- Login (modo nuvem) ----------
function viewLogin() {
  $('#tabs').style.display = 'none';
  $('#main').innerHTML = `<div class="card login"><h2>Entrar</h2><div class="muted small">Use seu e-mail e senha. No primeiro acesso, toque em "Criar conta".</div>
    <form><label>E-mail</label><input name="email" type="email" autocomplete="email" required><label>Senha</label><input name="password" type="password" autocomplete="current-password" minlength="6" required>
    <div class="actions"><button class="btn primary" value="in">Entrar</button><button class="btn" value="up">Criar conta</button></div><div class="muted small" id="msg" style="margin-top:10px"></div></form></div>`;
  const f = $('#main form');
  f.onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f)); const msg = $('#msg');
    try {
      if (e.submitter?.value === 'up') { const r = await store.signUp(d.email, d.password); if (!r.session) { msg.textContent = 'Conta criada. Confirme pelo link que chegou no seu e-mail e depois entre aqui.'; return; } }
      else await store.signIn(d.email, d.password);
      $('#tabs').style.display = ''; await start();
    } catch (err) { const m = String(err.message || err); msg.textContent = /invalid login/i.test(m) ? 'E-mail ou senha incorretos.' : /not confirmed/i.test(m) ? 'Confirme o e-mail pelo link que chegou na sua caixa de entrada.' : /already registered/i.test(m) ? 'Esse e-mail já tem conta. Use Entrar.' : 'Não deu certo: ' + m; } };
}

async function start() {
  try { await loadAll(); } catch (e) { console.error(e); $('#main').innerHTML = `<div class="card">Erro ao carregar os dados: ${esc(e.message || e)}</div>`; return; }
  render();
}

$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.tab = b.dataset.tab; try { localStorage.setItem('tab', S.tab); } catch {} render(); scrollTo(0, 0); });
$('#btn-settings').onclick = () => S.settings && showSettings();
try { S.tab = localStorage.getItem('tab') || 'hoje'; } catch {}

(async () => {
  const ok = await store.init();
  $('#mode').textContent = store.mode === 'cloud' ? '☁️' : '📱';
  if (store.mode === 'cloud' && !ok) return viewLogin();
  await start();
})();
