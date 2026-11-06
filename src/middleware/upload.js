'use strict';

/**
 * upload.js
 * Multer configuration for IDE Nacional (IDEP).
 *
 * Exports three pre-configured upload handlers:
 *
 *   uploadGeo   – geographic data files  (field: 'archivo')
 *   uploadPdf   – resolution / PDF files (field: 'resolucion')
 *   uploadLyr   – ESRI LYR style files   (field: 'lyr')
 *
 * Storage  : disk storage under UPLOAD_DIR, filename prefixed with
 *            ISO date + random suffix to avoid collisions.
 * Limits   : UPLOAD_MAX_MB × 1 MiB per file (default 500 MiB).
 * Filtering: only whitelisted extensions are accepted.
 */

const path    = require('path');
const multer  = require('multer');
const crypto  = require('crypto');
const config  = require('../config');

// ── Allowed extensions per upload type ────────────────────────────────────

const GEO_EXTENSIONS = new Set([
  '.zip', '.gdb', '.dxf', '.kml', '.kmz',
  '.csv', '.xlsx', '.geojson', '.gpkg',
]);

const PDF_EXTENSIONS = new Set(['.pdf']);

const LYR_EXTENSIONS = new Set(['.lyr']);

// ── Disk storage ───────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, config.UPLOAD_DIR);
  },

  filename(req, file, cb) {
    const ext    = path.extname(file.originalname).toLowerCase();
    const date   = new Date().toISOString().slice(0, 10);           // YYYY-MM-DD
    const random = crypto.randomBytes(8).toString('hex');
    const safe   = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .slice(0, 80);                                                 // cap length
    cb(null, `${date}_${safe}_${random}${ext}`);
  },
});

// ── File size limit ────────────────────────────────────────────────────────

const fileSizeLimit = config.UPLOAD_MAX_MB * 1024 * 1024;

// ── Filter factory ─────────────────────────────────────────────────────────

/**
 * Build a multer fileFilter that whitelists the given extension Set.
 *
 * @param {Set<string>} allowedExts
 * @returns {multer.Options['fileFilter']}
 */
function makeFilter(allowedExts) {
  return function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.has(ext)) {
      cb(null, true);
    } else {
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname);
      err.message = `Tipo de archivo no permitido: "${ext}". ` +
        `Extensiones aceptadas: ${[...allowedExts].join(', ')}`;
      cb(err, false);
    }
  };
}

// ── Multer instances ───────────────────────────────────────────────────────

const _geoUpload = multer({
  storage,
  limits:     { fileSize: fileSizeLimit },
  fileFilter: makeFilter(GEO_EXTENSIONS),
});

const _pdfUpload = multer({
  storage,
  limits:     { fileSize: fileSizeLimit },
  fileFilter: makeFilter(PDF_EXTENSIONS),
});

const _lyrUpload = multer({
  storage,
  limits:     { fileSize: fileSizeLimit },
  fileFilter: makeFilter(LYR_EXTENSIONS),
});

// ── Public middleware ──────────────────────────────────────────────────────

/** Upload a single geographic-data file in the 'archivo' field. */
const uploadGeo = _geoUpload.single('archivo');

/** Upload a single PDF resolution document in the 'resolucion' field. */
const uploadPdf = _pdfUpload.single('resolucion');

/** Upload a single ESRI LYR style file in the 'lyr' field. */
const uploadLyr = _lyrUpload.single('lyr');

module.exports = { uploadGeo, uploadPdf, uploadLyr };
