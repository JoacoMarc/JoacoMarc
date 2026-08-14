/**
 * Lectura incremental de los logs de Claude Code.
 *
 * Claude Code escribe una línea JSON por evento en
 *   macOS/Linux : ~/.claude/projects/<proyecto>/<sesión>.jsonl
 *   Windows     : %USERPROFILE%\.claude\projects\<proyecto>\<sesión>.jsonl
 *
 * `os.homedir()` resuelve las dos, así que no hace falta código por plataforma.
 *
 * El parseo es incremental: se guarda el tamaño, el mtime y el offset de cada archivo
 * ya procesado y sólo se releen los bytes nuevos. Sin esto, el hook que corre al final
 * de cada turno reprocesaría meses de historial y se pondría más lento cada semana.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directorio de logs por defecto, válido en macOS, Linux y Windows. */
export function defaultLogRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Lee la cuenta logueada desde `~/.claude.json`.
 *
 * Los registros de los logs NO contienen ningún identificador de cuenta, así que ésta
 * es la única fuente. Es el estado actual, no un histórico: por eso el exportador
 * estampa cada archivo con la cuenta vigente la primera vez que lo procesa y después
 * no la vuelve a tocar. Así, si cambiás de cuenta en una máquina, lo ya registrado
 * conserva la atribución correcta.
 */
export function readAccount(homeDir = os.homedir()) {
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8');
    const acct = JSON.parse(raw)?.oauthAccount;
    if (!acct) return null;
    return {
      uuid: acct.accountUuid ?? null,
      email: acct.emailAddress ?? null,
      orgUuid: acct.organizationUuid ?? null,
    };
  } catch {
    return null;
  }
}

/** Lista recursiva de archivos `.jsonl` bajo `root`. */
export function scanLogFiles(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...scanLogFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Lee los bytes nuevos de un archivo a partir de `offset` y devuelve las líneas
 * completas más el offset actualizado.
 *
 * Descarta deliberadamente la última línea si quedó incompleta: el archivo puede estar
 * siendo escrito en este mismo momento por una sesión activa. Esa línea se va a leer
 * entera en la próxima corrida.
 */
function readNewLines(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size <= offset) return { lines: [], offset };

    const buf = Buffer.allocUnsafe(size - offset);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.subarray(0, bytesRead);

    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], offset };

    const complete = chunk.subarray(0, lastNewline + 1);
    const text = complete.toString('utf8');
    return {
      lines: text.split('\n').filter((l) => l.length > 0),
      offset: offset + complete.length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Nombre de proyecto a partir del `cwd`. */
function projectFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'desconocido';
  // Normaliza separadores para que Windows y macOS produzcan el mismo nombre: así el
  // mismo proyecto clonado en las dos máquinas se consolida en una sola fila.
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'desconocido';
}

/**
 * Hora local `YYYY-MM-DDTHH` a partir de un timestamp ISO en UTC.
 *
 * Se convierte a hora local a propósito: el heatmap tiene que reflejar cuándo trabajaste
 * vos, no en qué hora UTC cayó. Como cada máquina agrega con su propio huso, la hora
 * queda correcta en origen.
 */
function localHourKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}`
  );
}

/** Clave del bucket agregado. */
export function bucketKey(b) {
  return [b.hour, b.project, b.model, b.tier, b.effort, b.sidechain ? 1 : 0].join('|');
}

function emptyCounters() {
  return {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
    messages: 0,
  };
}

function addCounters(target, rec) {
  target.input += rec.input;
  target.cacheWrite5m += rec.cacheWrite5m;
  target.cacheWrite1h += rec.cacheWrite1h;
  target.cacheRead += rec.cacheRead;
  target.output += rec.output;
  target.thinking += rec.thinking;
  target.webSearch += rec.webSearch;
  target.webFetch += rec.webFetch;
  target.messages += 1;
}

/**
 * Convierte una línea de log en un registro normalizado, o `null` si la línea no
 * representa consumo facturable.
 */
export function recordFromLine(line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d?.type !== 'assistant') return null;

  const msg = d.message;
  const usage = msg?.usage;
  if (!usage || !msg?.id) return null;

  const hour = localHourKey(d.timestamp);
  if (!hour) return null;

  const creation = usage.cache_creation ?? {};
  // Si falta el desglose por TTL (versiones viejas del log), se asume el cache de 5
  // minutos, que es el default de Claude Code y el multiplicador más bajo. Es la
  // suposición conservadora: subestima antes que inflar el costo.
  const hasSplit =
    creation.ephemeral_5m_input_tokens != null || creation.ephemeral_1h_input_tokens != null;
  const totalWrite = usage.cache_creation_input_tokens ?? 0;

  return {
    id: msg.id,
    hour,
    project: projectFromCwd(d.cwd),
    model: msg.model ?? 'desconocido',
    tier: usage.service_tier ?? 'standard',
    effort: d.effort ?? 'default',
    sidechain: d.isSidechain === true,
    sessionId: d.sessionId ?? null,
    entrypoint: d.entrypoint ?? null,
    timestamp: d.timestamp,

    input: usage.input_tokens ?? 0,
    cacheWrite5m: hasSplit ? (creation.ephemeral_5m_input_tokens ?? 0) : totalWrite,
    cacheWrite1h: hasSplit ? (creation.ephemeral_1h_input_tokens ?? 0) : 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
    webSearch: usage.server_tool_use?.web_search_requests ?? 0,
    webFetch: usage.server_tool_use?.web_fetch_requests ?? 0,
  };
}

/**
 * Procesa todos los logs, reutilizando el cache para los archivos que no cambiaron.
 *
 * @param {object} opts
 * @param {string} opts.root      Directorio de logs.
 * @param {object} opts.cache     Cache previo (se muta y se devuelve).
 * @param {object} opts.account   Cuenta logueada, para estampar archivos nuevos.
 * @returns {{cache: object, stats: object}}
 */
export function parseAll({ root, cache = { version: 1, files: {} }, account = null }) {
  const files = scanLogFiles(root);
  const present = new Set(files);
  const stats = { files: files.length, changed: 0, newRecords: 0, skippedDuplicates: 0 };

  // Los archivos que ya no existen se dejan en el cache a propósito: Claude Code borra
  // logs viejos, y sus buckets ya agregados son lo único que queda de ese consumo.
  for (const key of Object.keys(cache.files)) {
    if (!present.has(key)) cache.files[key].missing = true;
  }

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    let entry = cache.files[file];
    // Si el archivo encogió, fue truncado o rotado: se reconstruye desde cero.
    if (!entry || stat.size < entry.offset) {
      entry = {
        offset: 0,
        size: 0,
        mtimeMs: 0,
        // La cuenta se estampa una sola vez, al ver el archivo por primera vez.
        account: account ? { uuid: account.uuid, email: account.email } : null,
        buckets: {},
        seen: [],
        session: null,
      };
      cache.files[file] = entry;
    }
    entry.missing = false;

    if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) continue;

    const { lines, offset } = readNewLines(file, entry.offset);
    stats.changed += 1;

    const seen = new Set(entry.seen);
    for (const line of lines) {
      const rec = recordFromLine(line);
      if (!rec) continue;
      if (seen.has(rec.id)) {
        stats.skippedDuplicates += 1;
        continue;
      }
      seen.add(rec.id);
      stats.newRecords += 1;

      const key = bucketKey(rec);
      const bucket = (entry.buckets[key] ??= {
        hour: rec.hour,
        project: rec.project,
        model: rec.model,
        tier: rec.tier,
        effort: rec.effort,
        sidechain: rec.sidechain,
        ...emptyCounters(),
      });
      addCounters(bucket, rec);

      entry.session ??= {
        id: rec.sessionId,
        project: rec.project,
        entrypoint: rec.entrypoint,
        startedAt: rec.timestamp,
        endedAt: rec.timestamp,
        models: [],
        ...emptyCounters(),
      };
      const s = entry.session;
      if (rec.timestamp < s.startedAt) s.startedAt = rec.timestamp;
      if (rec.timestamp > s.endedAt) s.endedAt = rec.timestamp;
      if (!s.models.includes(rec.model)) s.models.push(rec.model);
      addCounters(s, rec);
    }

    entry.seen = [...seen];
    entry.offset = offset;
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
  }

  return { cache, stats };
}
