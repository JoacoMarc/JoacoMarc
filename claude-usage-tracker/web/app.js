/**
 * Interfaz del tracker.
 *
 * La tabla de precios se importa del mismo módulo que usa el exportador, así que el
 * costo que ves acá y el que imprime la consola salen del mismo lugar.
 */

import { costOfBucket } from '/src/pricing.js';

const PALETTE = [
  '#d97757', '#4ec9a5', '#6ea8fe', '#c792ea',
  '#e0af68', '#7ee787', '#f78c6c', '#82aaff',
];

const state = {
  data: null,
  from: null,
  to: null,
  granularity: 'day',
  stackBy: 'model',
  projects: new Set(),
  models: new Set(),
  machines: new Set(),
  includeSidechain: true,
};

const $ = (id) => document.getElementById(id);
const usd = (n) =>
  n.toLocaleString('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usdPrecise = (n) =>
  n < 0.01 && n > 0 ? `USD ${n.toFixed(4)}` : usd(n);
const num = (n) => n.toLocaleString('es-AR', { maximumFractionDigits: 0 });
const pct = (n) => `${(n * 100).toFixed(1)}%`;

/* ---------- fechas ---------- */

/** Parsea `YYYY-MM-DD` en hora local (evita el corrimiento de zona de `new Date(str)`). */
function localDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Lunes de la semana de una fecha. */
function weekStart(iso) {
  const d = localDate(iso);
  const shift = (d.getDay() + 6) % 7; // domingo = 0 → 6
  d.setDate(d.getDate() - shift);
  return fmtDate(d);
}

function periodKey(hour, granularity) {
  const date = hour.slice(0, 10);
  if (granularity === 'month') return date.slice(0, 7);
  if (granularity === 'week') return weekStart(date);
  return date;
}

function periodLabel(key, granularity) {
  if (granularity === 'month') {
    // Año completo a propósito: con dos dígitos, "ago 26" se lee como 26 de agosto.
    return localDate(`${key}-01`).toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
  }
  const d = localDate(key);
  const short = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  return granularity === 'week' ? `sem. ${short}` : short;
}

/* ---------- datos ---------- */

/**
 * Carga el índice y después el archivo de cada máquina, y los fusiona en memoria.
 *
 * Todo del lado del cliente y con rutas relativas: el mismo código funciona servido por
 * `serve.js` en local y como sitio estático deployado, sin backend.
 */
async function loadData() {
  const index = await fetch('data/index.json', { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`no se pudo leer data/index.json (${r.status})`);
    return r.json();
  });

  const buckets = [];
  const sessions = [];
  const machines = [];
  const accounts = new Map();

  const files = await Promise.all(
    index.machines.map(async ({ file }) => {
      const res = await fetch(`data/${file}`, { cache: 'no-store' });
      return res.ok ? { file, data: await res.json() } : null;
    }),
  );

  for (const entry of files) {
    if (!entry?.data?.buckets) continue;
    const { file, data } = entry;
    const machine = data.machine ?? file.replace(/\.json$/, '');

    machines.push({ name: machine, updatedAt: data.updatedAt ?? null });
    // La máquina se agrega acá y no en el archivo exportado: cada archivo queda acotado
    // a sus propios datos y el filtro por máquina se arma al fusionar.
    for (const b of data.buckets) buckets.push({ ...b, machine });
    for (const s of data.sessions ?? []) sessions.push({ ...s, machine });
    for (const a of data.accounts ?? []) if (a?.uuid) accounts.set(a.uuid, a);
  }

  return { buckets, sessions, machines, accounts: [...accounts.values()], plan: index.plan };
}

async function boot() {
  state.data = await loadData();

  if (!state.data.buckets?.length) {
    $('scope').textContent = 'Sin datos';
    $('empty').hidden = false;
    return;
  }

  const hours = state.data.buckets.map((b) => b.hour);
  const min = hours.reduce((a, b) => (a < b ? a : b)).slice(0, 10);
  const max = hours.reduce((a, b) => (a > b ? a : b)).slice(0, 10);
  state.bounds = { min, max };
  applyPreset('month');

  for (const b of state.data.buckets) {
    state.projects.add(b.project);
    state.models.add(b.model);
    state.machines.add(b.machine);
  }
  state.selectedProjects = new Set(state.projects);
  state.selectedModels = new Set(state.models);
  state.selectedMachines = new Set(state.machines);

  buildFilters();
  $('app').hidden = false;
  render();
}

function applyPreset(preset) {
  const today = new Date();
  const end = fmtDate(today);
  if (preset === 'month') {
    state.from = `${end.slice(0, 7)}-01`;
    state.to = end;
  } else if (preset === '30d' || preset === '90d') {
    const d = new Date(today);
    d.setDate(d.getDate() - (preset === '30d' ? 29 : 89));
    state.from = fmtDate(d);
    state.to = end;
  } else {
    state.from = state.bounds.min;
    state.to = state.bounds.max;
  }
  state.preset = preset;
}

/** Buckets que pasan todos los filtros activos. */
function filtered() {
  return state.data.buckets.filter((b) => {
    const date = b.hour.slice(0, 10);
    if (date < state.from || date > state.to) return false;
    if (!state.selectedProjects.has(b.project)) return false;
    if (!state.selectedModels.has(b.model)) return false;
    if (!state.selectedMachines.has(b.machine)) return false;
    if (!state.includeSidechain && b.sidechain) return false;
    return true;
  });
}

/* ---------- filtros ---------- */

function segmented(el, options, current, onPick) {
  el.replaceChildren(
    ...options.map(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(value === current));
      b.onclick = () => onPick(value);
      return b;
    }),
  );
}

function chips(el, all, selected, onToggle) {
  el.replaceChildren(
    ...[...all].sort().map((value) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = value;
      b.setAttribute('aria-pressed', String(selected.has(value)));
      b.onclick = () => onToggle(value);
      return b;
    }),
  );
}

function buildFilters() {
  segmented(
    $('preset'),
    [['month', 'Este mes'], ['30d', '30 días'], ['90d', '90 días'], ['all', 'Todo']],
    state.preset,
    (v) => {
      applyPreset(v);
      buildFilters();
      render();
    },
  );

  segmented(
    $('granularity'),
    [['day', 'Día'], ['week', 'Semana'], ['month', 'Mes']],
    state.granularity,
    (v) => {
      state.granularity = v;
      buildFilters();
      render();
    },
  );

  segmented(
    $('stackBy'),
    [['model', 'Por modelo'], ['project', 'Por proyecto'], ['machine', 'Por máquina']],
    state.stackBy,
    (v) => {
      state.stackBy = v;
      buildFilters();
      render();
    },
  );

  $('from').value = state.from;
  $('to').value = state.to;
  $('from').onchange = (e) => {
    state.from = e.target.value;
    state.preset = null;
    buildFilters();
    render();
  };
  $('to').onchange = (e) => {
    state.to = e.target.value;
    state.preset = null;
    buildFilters();
    render();
  };

  /**
   * Alterna un valor del filtro. Click sobre el único activo vuelve a seleccionar todo:
   * sin eso quedarías con el filtro vacío y la pantalla en blanco, que nunca es lo que
   * querías al hacer ese click.
   */
  const toggle = (selected, all, value) => {
    if (selected.has(value) && selected.size === 1) return new Set(all);
    const next = new Set(selected);
    next.has(value) ? next.delete(value) : next.add(value);
    return next;
  };

  chips($('projects'), state.projects, state.selectedProjects, (v) => {
    state.selectedProjects = toggle(state.selectedProjects, state.projects, v);
    buildFilters();
    render();
  });
  chips($('models'), state.models, state.selectedModels, (v) => {
    state.selectedModels = toggle(state.selectedModels, state.models, v);
    buildFilters();
    render();
  });
  chips($('machineFilter'), state.machines, state.selectedMachines, (v) => {
    state.selectedMachines = toggle(state.selectedMachines, state.machines, v);
    buildFilters();
    render();
  });

  $('includeSidechain').onchange = (e) => {
    state.includeSidechain = e.target.checked;
    render();
  };

  $('machines').replaceChildren(
    ...state.data.machines.map((m) => {
      const el = document.createElement('div');
      el.className = 'machine-chip';
      const when = m.updatedAt
        ? new Date(m.updatedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
        : 'sin fecha';
      el.innerHTML = `<strong>${escapeHtml(m.name)}</strong> · ${when}`;
      return el;
    }),
  );
}

/* ---------- render ---------- */

function render() {
  const rows = filtered();
  const totals = totalsOf(rows);

  $('scope').textContent =
    `${rows.length} buckets · ${state.from} → ${state.to} · ` +
    `${state.data.machines.length} ${state.data.machines.length === 1 ? 'máquina' : 'máquinas'}`;

  const unknown = [...new Set(rows.filter((b) => costOfBucket(b).unknownModel).map((b) => b.model))];
  const warn = $('warning');
  warn.hidden = unknown.length === 0;
  if (unknown.length) {
    warn.textContent =
      `Modelos sin precio en la tabla: ${unknown.join(', ')}. Su consumo aparece en los ` +
      `tokens pero cuenta como USD 0, así que el costo real es mayor al que ves.`;
  }

  renderKpis(rows, totals);
  renderTimeseries(rows);
  renderMix($('modelMix'), rows, 'model');
  renderMix($('projectMix'), rows, 'project');
  renderCache(totals);
  renderExtras(rows, totals);
  renderHeatmap(rows);
  renderSessions();
}

function totalsOf(rows) {
  const t = {
    cost: 0, withoutCache: 0, input: 0, cacheWrite: 0, cacheRead: 0,
    output: 0, thinking: 0, webSearch: 0, webFetch: 0, messages: 0, sidechainCost: 0,
  };
  for (const b of rows) {
    const c = costOfBucket(b);
    t.cost += c.total;
    t.withoutCache += c.withoutCache;
    t.input += b.input;
    t.cacheWrite += b.cacheWrite5m + b.cacheWrite1h;
    t.cacheRead += b.cacheRead;
    t.output += b.output;
    t.thinking += b.thinking;
    t.webSearch += b.webSearch;
    t.webFetch += b.webFetch;
    t.messages += b.messages;
    if (b.sidechain) t.sidechainCost += c.total;
  }
  t.tokens = t.input + t.cacheWrite + t.cacheRead + t.output;
  return t;
}

function renderKpis(rows, totals) {
  const seat = state.data.plan?.seatCostUsd ?? 0;
  const planLabel = state.data.plan?.label ?? 'plan';

  // Break-even: se compara contra el mes calendario, que es la unidad en la que se
  // factura la suscripción — no contra el período filtrado, que puede ser cualquiera.
  const thisMonth = fmtDate(new Date()).slice(0, 7);
  const monthRows = state.data.buckets.filter(
    (b) => b.hour.startsWith(thisMonth) && (state.includeSidechain || !b.sidechain),
  );
  const monthCost = monthRows.reduce((s, b) => s + costOfBucket(b).total, 0);

  const now = new Date();
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = daysElapsed > 0 ? (monthCost / daysElapsed) * daysInMonth : 0;

  const ratio = seat > 0 ? monthCost / seat : 0;
  const beNote =
    seat <= 0
      ? 'Configurá plan.seatCostUsd'
      : monthCost >= seat
        ? `Ya superaste el asiento (${pct(ratio)})`
        : `Vas ${pct(ratio)} del asiento de ${usd(seat)}`;

  // El color se decide por la proyección, no por lo consumido hasta hoy: a mitad de mes
  // ir por el 55% del asiento es ir bien, y pintarlo en rojo sería una falsa alarma.
  const beTone = seat <= 0 ? '' : projected >= seat ? 'good' : 'bad';

  const cards = [
    { label: 'Costo del período', value: usd(totals.cost), note: `${num(totals.messages)} mensajes` },
    { label: 'Tokens del período', value: num(totals.tokens), note: `${num(totals.output)} de salida` },
    {
      label: `Mes actual vs ${planLabel}`,
      value: usd(monthCost),
      note: beNote,
      tone: beTone,
    },
    {
      label: 'Proyección fin de mes',
      value: usd(projected),
      note:
        seat > 0 && projected < seat
          ? `al ritmo actual no llegás al asiento de ${usd(seat)}`
          : `al ritmo de los primeros ${daysElapsed} días`,
    },
  ];

  $('kpis').replaceChildren(
    ...cards.map((c) => {
      const el = document.createElement('div');
      el.className = 'kpi';
      el.innerHTML =
        `<div class="label">${escapeHtml(c.label)}</div>` +
        `<div class="value">${escapeHtml(c.value)}</div>` +
        `<div class="note ${c.tone ?? ''}">${escapeHtml(c.note)}</div>`;
      return el;
    }),
  );
}

function colorMap(keys) {
  const map = new Map();
  [...keys].sort().forEach((k, i) => map.set(k, PALETTE[i % PALETTE.length]));
  return map;
}

/**
 * Dibuja la línea del costo del asiento sobre el gráfico mensual.
 *
 * Va como plugin inline en vez de traer chartjs-plugin-annotation: es la única
 * anotación que necesitamos y son veinte líneas.
 */
const seatLinePlugin = {
  id: 'seatLine',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts?.value || opts.value <= 0) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y.getPixelForValue(opts.value);
    if (y < chartArea.top || y > chartArea.bottom) return;

    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = opts.color;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.label, chartArea.right - 4, y - 3);
    ctx.restore();
  },
};

let timeseriesChart = null;

function renderTimeseries(rows) {
  const dim = state.stackBy;
  const periods = new Map();
  const seriesKeys = new Set();

  for (const b of rows) {
    const key = periodKey(b.hour, state.granularity);
    seriesKeys.add(b[dim]);
    const p = periods.get(key) ?? new Map();
    p.set(b[dim], (p.get(b[dim]) ?? 0) + costOfBucket(b).total);
    periods.set(key, p);
  }

  const colors = colorMap(seriesKeys);
  const labels = [...periods.keys()].sort();
  const series = [...seriesKeys].sort();

  const datasets = series.map((name) => ({
    label: name,
    data: labels.map((key) => periods.get(key).get(name) ?? 0),
    backgroundColor: colors.get(name),
    borderWidth: 0,
    borderRadius: 2,
    // Sin tope, un único período estira la barra a todo el ancho del panel y parece un
    // bloque de color en vez de un gráfico.
    maxBarThickness: 72,
  }));

  // La línea de referencia sólo tiene sentido con granularidad mensual: la suscripción
  // se factura por mes, comparar un día contra el asiento no dice nada.
  const seat = state.granularity === 'month' ? (state.data.plan?.seatCostUsd ?? 0) : 0;

  timeseriesChart?.destroy();
  timeseriesChart = new Chart($('timeseries'), {
    type: 'bar',
    data: { labels: labels.map((k) => periodLabel(k, state.granularity)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { color: '#8b96a5', maxRotation: 0, autoSkipPadding: 16 },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: '#2a323d' },
          ticks: {
            color: '#8b96a5',
            callback: (v) => (v === 0 || v >= 1 ? `$${v}` : `$${Number(v).toFixed(2)}`),
          },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#8b96a5', boxWidth: 10, boxHeight: 10, usePointStyle: true },
        },
        tooltip: {
          // Sin esto Chart.js lista las series en 0, que en un stack por proyecto son casi
          // todas y vuelven el tooltip ilegible.
          filter: (item) => item.parsed.y > 0,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${usdPrecise(ctx.parsed.y)}`,
            footer: (items) => `Total: ${usdPrecise(sum(items.map((i) => i.parsed.y)))}`,
          },
        },
        seatLine: { value: seat, label: `asiento ${usd(seat)}`, color: '#d97757' },
      },
    },
    plugins: [seatLinePlugin],
  });
}

function renderMix(container, rows, dim) {
  const by = new Map();
  for (const b of rows) by.set(b[dim], (by.get(b[dim]) ?? 0) + costOfBucket(b).total);

  const entries = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const total = sum(entries.map((e) => e[1])) || 1;
  const colors = colorMap(by.keys());

  container.replaceChildren(
    ...entries.map(([name, value]) => {
      const el = document.createElement('div');
      el.className = 'hbar';
      el.innerHTML =
        `<div class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>` +
        `<div class="track"><div class="fill" style="width:${(value / total) * 100}%;background:${colors.get(name)}"></div></div>` +
        `<div class="amount">${escapeHtml(usdPrecise(value))} · ${pct(value / total)}</div>`;
      return el;
    }),
  );
}

function renderCache(t) {
  const totalInput = t.input + t.cacheWrite + t.cacheRead;
  const savings = t.withoutCache - t.cost;
  const rows = [
    ['Input servido desde cache', totalInput ? pct(t.cacheRead / totalInput) : '—'],
    ['Tokens leídos del cache', num(t.cacheRead)],
    ['Tokens escritos al cache', num(t.cacheWrite)],
    ['Input sin cachear', num(t.input)],
    [
      savings >= 0 ? 'Ahorro por cache' : 'Sobrecosto por cache',
      `${savings >= 0 ? '' : '−'}${usd(Math.abs(savings))}`,
    ],
  ];
  $('cache').replaceChildren(...rows.map(statRow));
  const note = document.createElement('p');
  note.className = 'hint';
  note.style.margin = '12px 0 0';
  note.textContent =
    savings >= 0
      ? 'Comparado contra el escenario sin cache, donde cada token escrito o leído se facturaría como input normal.'
      : 'Estás escribiendo más cache del que después leés: en este período el cache salió más caro que no usarlo.';
  $('cache').append(note);
}

function renderExtras(rows, t) {
  const data = [
    ['Mensajes del asistente', num(t.messages)],
    ['Tokens de salida', num(t.output)],
    ['De los cuales, thinking', `${num(t.thinking)} (${t.output ? pct(t.thinking / t.output) : '—'})`],
    ['Gasto en subagentes', `${usdPrecise(t.sidechainCost)} (${t.cost ? pct(t.sidechainCost / t.cost) : '—'})`],
    ['Búsquedas web', `${num(t.webSearch)} · ${usdPrecise(t.webSearch * 0.01)}`],
    ['Fetches web', num(t.webFetch)],
  ];
  $('extras').replaceChildren(...data.map(statRow));
}

function statRow([k, v]) {
  const el = document.createElement('div');
  el.className = 'stat';
  el.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span>`;
  return el;
}

const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function renderHeatmap(rows) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const b of rows) {
    const date = b.hour.slice(0, 10);
    const hour = Number(b.hour.slice(11, 13));
    const day = (localDate(date).getDay() + 6) % 7;
    grid[day][hour] += costOfBucket(b).total;
  }
  const max = Math.max(...grid.flat(), 0.0001);

  const heat = document.createElement('div');
  heat.className = 'heat';
  heat.append(cell('', 'lbl'));
  for (let h = 0; h < 24; h++) heat.append(cell(h % 3 === 0 ? String(h) : '', 'hr'));

  grid.forEach((hours, d) => {
    heat.append(cell(DAYS[d], 'lbl'));
    hours.forEach((value, h) => {
      const c = cell('', 'cell');
      if (value > 0) {
        // Escala con raíz cuadrada: sin esto, un pico aplasta visualmente al resto.
        const intensity = Math.sqrt(value / max);
        c.style.background = `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, var(--panel-2))`;
      }
      c.title = `${DAYS[d]} ${String(h).padStart(2, '0')}:00 — ${usdPrecise(value)}`;
      heat.append(c);
    });
  });

  const wrap = document.createElement('div');
  wrap.className = 'heat-wrap';
  wrap.append(heat);
  $('heatmap').replaceChildren(wrap);
}

function cell(text, className) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function renderSessions() {
  const inRange = state.data.sessions
    .filter((s) => {
      const date = (s.startedAt ?? '').slice(0, 10);
      return (
        date >= state.from &&
        date <= state.to &&
        state.selectedProjects.has(s.project) &&
        state.selectedMachines.has(s.machine)
      );
    })
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 12);

  if (!inRange.length) {
    $('sessions').innerHTML = '<p class="hint">Sin sesiones en el período.</p>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr><th>Inicio</th><th>Proyecto</th><th>Máquina</th>' +
    '<th class="num">Mensajes</th><th class="num">Salida</th><th class="num">Costo</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const s of inRange) {
    const tr = document.createElement('tr');
    const started = new Date(s.startedAt).toLocaleString('es-AR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    tr.innerHTML =
      `<td>${escapeHtml(started)}</td>` +
      `<td class="name">${escapeHtml(s.project ?? '—')}</td>` +
      `<td class="name">${escapeHtml(s.machine ?? '—')}</td>` +
      `<td class="num">${num(s.messages ?? 0)}</td>` +
      `<td class="num">${num(s.output ?? 0)}</td>` +
      `<td class="num">${escapeHtml(usdPrecise(s.costUsd ?? 0))}</td>`;
    body.append(tr);
  }
  table.append(body);

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.append(table);
  $('sessions').replaceChildren(wrap);
}

/* ---------- utilidades ---------- */

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

boot().catch((err) => {
  $('scope').textContent = `Error: ${err.message}`;
  console.error(err);
});
