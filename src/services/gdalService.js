'use strict';

/**
 * gdalService.js
 * Thin wrapper around GDAL CLI tools (ogrinfo, ogr2ogr).
 * Supports two modes controlled by config.GDAL_MODE:
 *   "docker" → commands are prefixed with `docker exec <container>`
 *   "local"  → binaries must exist on PATH
 */

const { exec } = require('child_process');
const { spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const config = require('../config');

const execAsync = promisify(exec);

// ── internal helpers ──────────────────────────────────────────────────────

/**
 * Execute a command string through the shell.
 * In docker mode the command is wrapped with `docker exec <container> sh -c "..."`.
 * Returns {stdout, stderr, exitCode}.
 *
 * @param {string} command  full GDAL command (ogrinfo …, gdalinfo …, etc.)
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function run(command) {
  let fullCmd;
  if (config.gdalIsDocker) {
    // Use sh -c so the container can handle internal quoting / env vars
    const escaped = command.replace(/"/g, '\\"');
    fullCmd = `docker exec ${config.GDAL_CONTAINER} sh -c "${escaped}"`;
  } else {
    fullCmd = command;
  }

  try {
    const { stdout, stderr } = await execAsync(fullCmd, {
      maxBuffer: 100 * 1024 * 1024, // 100 MB
    });
    return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

/**
 * Spawn a GDAL command with an explicit args array, avoiding shell quoting issues
 * for values that may contain special characters (e.g. DATABASE_URL passwords).
 * In docker mode prepends ['docker', 'exec', container].
 *
 * @param {string}   bin  binary name (e.g. 'ogr2ogr')
 * @param {string[]} args argument list
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function spawnAsync(bin, args) {
  let cmd, argv;
  if (config.gdalIsDocker) {
    cmd = 'docker';
    argv = ['exec', config.GDAL_CONTAINER, bin, ...args];
  } else {
    cmd = bin;
    argv = args;
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    proc.on('error', (err) => resolve({ stdout, stderr, exitCode: 1, _err: err.message }));
  });
}

// ── ogrinfo output parser ─────────────────────────────────────────────────

function parseFormato(stdout) {
  const m = stdout.match(/using driver `([^']+)' successful/i);
  if (m) return m[1];
  // Try alternate quoting used by newer GDAL
  const m2 = stdout.match(/using driver "([^"]+)" successful/i);
  return m2 ? m2[1] : '';
}

/**
 * Split ogrinfo -al -so stdout into individual layer text blocks.
 */
function splitLayerBlocks(stdout) {
  // Each layer begins with a "Layer name:" line
  const blocks = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    if (/^Layer name:/i.test(line.trim())) {
      if (current !== null) blocks.push(current);
      current = line + '\n';
    } else if (current !== null) {
      current += line + '\n';
    }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

function parseLayerBlock(block) {
  const lines = block.split('\n');

  const getVal = (prefix) => {
    const l = lines.find((l) => l.trimStart().startsWith(prefix));
    return l ? l.slice(l.indexOf(prefix) + prefix.length).trim() : null;
  };

  const nombre = getVal('Layer name:') || '';
  const tipoGeometria = getVal('Geometry:') || '';
  const conteoStr = getVal('Feature Count:');
  const conteo = conteoStr !== null ? parseInt(conteoStr, 10) : null;

  // Extract EPSG code from WKT (ID["EPSG",xxxx] or AUTHORITY["EPSG","xxxx"])
  let crs = null;
  const idMatch = block.match(/\bID\s*\[\s*"EPSG"\s*,\s*(\d+)\s*\]/i);
  if (idMatch) {
    crs = `EPSG:${idMatch[1]}`;
  } else {
    const authMatch = block.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]/i);
    if (authMatch) crs = `EPSG:${authMatch[1]}`;
  }

  // Parse attribute fields (lines like "fieldName: Type (width.precision)")
  // They appear after all the geometry/SRS preamble lines.
  const campos = [];
  // Known header-section keywords to skip
  const headerSet = new Set([
    'layer name', 'geometry', 'feature count', 'extent',
    'layer srs wkt', 'fid column', 'geometry column',
  ]);
  // SRS block: indented lines between "Layer SRS WKT:" and the first blank line
  let inSrs = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { inSrs = false; continue; }

    if (/^Layer SRS WKT:/i.test(trimmed)) { inSrs = true; continue; }
    if (inSrs) {
      // SRS block ends at a non-indented line (no leading spaces)
      if (!/^\s/.test(line)) { inSrs = false; } else { continue; }
    }

    const lc = trimmed.toLowerCase();
    if (headerSet.has(lc.replace(/:.*/, '').trim())) continue;
    if (/^(FID Column|Geometry Column|Extent:|Layer SRS|GEOGCS|PROJCS|DATUM|PRIMEM|UNIT|AXIS|ID\[|AUTHORITY\[|PROJECTION\[|PARAMETER\[|TOWGS84\[)/i.test(trimmed)) continue;

    // Field line format: "FieldName: TypeName (width.precision)"
    const m = trimmed.match(/^([\w ]+?):\s+([A-Za-z_]\w*)/);
    if (m) {
      campos.push({ nombre: m[1].trim(), tipo: m[2].trim() });
    }
  }

  return { nombre, crs, conteo, tipo_geometria: tipoGeometria, campos };
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Inspect a spatial file with ogrinfo and return parsed layer metadata.
 *
 * @param {string} filePath  absolute path accessible by GDAL (host or container)
 * @returns {Promise<{formato: string, capas: Array, error?: string}>}
 */
async function ogrinfo(filePath) {
  const result = await run(`ogrinfo -al -so "${filePath}"`);

  if (result.exitCode !== 0) {
    return {
      formato: '',
      capas: [],
      error: (result.stderr || result.stdout || `ogrinfo exited with code ${result.exitCode}`).slice(0, 500),
    };
  }

  const formato = parseFormato(result.stdout);
  const blocks = splitLayerBlocks(result.stdout);
  const capas = blocks.map(parseLayerBlock);

  return { formato, capas };
}

/**
 * Convert a spatial file to a PostGIS table using ogr2ogr.
 *
 * @param {object} opts
 * @param {string}  opts.inputPath    source file path
 * @param {string}  opts.outputTable  target table name (no schema prefix)
 * @param {string}  [opts.schema='datos']
 * @param {number}  [opts.srid=4326]   source SRID hint (unused; ogr2ogr auto-detects)
 * @param {number}  [opts.outputSrid=4326]  reprojection target
 * @returns {Promise<{success: boolean, error?: string, instrucciones?: string, records_written?: number|null}>}
 */
async function convertir({ inputPath, outputTable, schema = 'datos', srid = 4326, outputSrid = 4326 }) {
  // ── Reject DWG ───────────────────────────────────────────────────────────
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.dwg') {
    return {
      success: false,
      error: 'DWG_NOT_SUPPORTED',
      instrucciones: [
        'Los archivos DWG (AutoCAD Drawing) no son compatibles directamente con ogr2ogr.',
        'Convierta el archivo a uno de los formatos soportados antes de subir:',
        '  • Shapefile (.shp + .dbf + .prj + .shx)',
        '  • GeoPackage (.gpkg)   ← formato recomendado',
        '  • GeoJSON (.geojson)',
        '  • FileGDB (.gdb)       — requiere licencia ESRI',
        'Herramientas de conversión: QGIS (gratuito), FME, ArcGIS Pro, AutoCAD Map 3D.',
      ].join('\n'),
    };
  }

  const pgConn = config.DATABASE_URL;
  const fullTable = `${schema}.${outputTable}`;

  // Use spawnAsync to pass DATABASE_URL as a literal arg, not through the shell
  const args = [
    '-f', 'PostgreSQL',
    `PG:${pgConn}`,
    inputPath,
    '-nln', fullTable,
    '-t_srs', `EPSG:${outputSrid}`,
    '-lco', 'GEOMETRY_NAME=geom',
    '-lco', 'FID=gid',
    '-overwrite',
    '--config', 'PG_USE_COPY', 'YES',
  ];

  const result = await spawnAsync('ogr2ogr', args);

  if (result.exitCode !== 0) {
    const errMsg = (result.stderr || result.stdout || `ogr2ogr exited with code ${result.exitCode}`).slice(0, 800);
    return { success: false, error: errMsg };
  }

  // ogr2ogr doesn't print a feature count on success; return null and let the
  // caller query the table directly if needed.
  const countMatch = (result.stdout + result.stderr).match(/(\d+)\s+feature[s]?\s+(?:written|loaded)/i);
  const records_written = countMatch ? parseInt(countMatch[1], 10) : null;

  return { success: true, records_written };
}

module.exports = { run, ogrinfo, convertir };
