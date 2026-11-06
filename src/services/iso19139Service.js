'use strict';

/**
 * iso19139Service.js
 * Generates an ISO 19139 (ISO 19115) XML metadata document from an
 * ide.metadata_records row.
 *
 * Note on xmlbuilder2 usage: calling `.ele()` on a node returns a NEW
 * builder wrapping the freshly created child; the original node reference
 * is unaffected and remains valid for adding further children later. The
 * small helpers below rely on that: they never need to return/chain a
 * cursor back to the caller, which avoids the classic `.up().up()` mistakes
 * of hand written fluent chains.
 */

const { create } = require('xmlbuilder2');

const CODELIST_BASE =
  'http://standards.iso.org/ittf/PubliclyAvailableStandards/ISO_19139_Schemas/resources/codelist/gmxCodelists.xml';

/** <tag><gco:CharacterString>value</gco:CharacterString></tag> */
function charString(parent, tag, value) {
  const el = parent.ele(tag);
  el.ele('gco:CharacterString').txt(value != null ? String(value) : '');
  return el;
}

/** <tag><gco:Decimal>value</gco:Decimal></tag> */
function decimalEl(parent, tag, value) {
  const el = parent.ele(tag);
  el.ele('gco:Decimal').txt(value != null && value !== '' ? String(value) : '0');
  return el;
}

/** <tag><codeListTag codeListValue="value" codeList="...">value</codeListTag></tag> */
function codeListEl(parent, tag, codeListTag, value) {
  const el = parent.ele(tag);
  el.ele(codeListTag, { codeListValue: value, codeList: `${CODELIST_BASE}#${codeListTag.replace(/^gmd:/, '')}` }).txt(value);
  return el;
}

/**
 * Build an ISO 19139 XML document for a dataset/service metadata record.
 *
 * @param {object} metadataRecord           ide.metadata_records row
 * @param {string} metadataRecord.file_identifier
 * @param {object} metadataRecord.contenido JSONB CCIDEP content
 * @returns {string} pretty-printed ISO 19139 XML
 */
function generar(metadataRecord) {
  if (!metadataRecord || !metadataRecord.file_identifier) {
    throw new Error('generar(metadataRecord) requiere file_identifier');
  }
  const c = metadataRecord.contenido || {};
  const fileIdentifier = metadataRecord.file_identifier;

  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('gmd:MD_Metadata', {
    'xmlns:gmd': 'http://www.isotc211.org/2005/gmd',
    'xmlns:gco': 'http://www.isotc211.org/2005/gco',
    'xmlns:gml': 'http://www.opengis.net/gml/3.2',
    'xmlns:xlink': 'http://www.w3.org/1999/xlink',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
  });

  charString(doc, 'gmd:fileIdentifier', fileIdentifier);
  charString(doc, 'gmd:language', 'spa');
  codeListEl(doc, 'gmd:characterSet', 'gmd:MD_CharacterSetCode', 'utf8');
  codeListEl(doc, 'gmd:hierarchyLevel', 'gmd:MD_ScopeCode', 'dataset');

  const dateStamp = doc.ele('gmd:dateStamp');
  dateStamp.ele('gco:Date').txt(new Date().toISOString().slice(0, 10));

  charString(doc, 'gmd:metadataStandardName', 'ISO 19115');
  charString(doc, 'gmd:metadataStandardVersion', '2003/Cor.1:2006');

  // ── Contact (point of contact for the metadata itself) ──────────────────
  if (c.contacto) {
    const contact = doc.ele('gmd:contact').ele('gmd:CI_ResponsibleParty');
    if (c.contacto.organizacion) charString(contact, 'gmd:organisationName', c.contacto.organizacion);
    if (c.contacto.email) {
      const address = contact.ele('gmd:contactInfo').ele('gmd:CI_Contact').ele('gmd:address').ele('gmd:CI_Address');
      charString(address, 'gmd:electronicMailAddress', c.contacto.email);
    }
    codeListEl(contact, 'gmd:role', 'gmd:CI_RoleCode', c.contacto.rol || 'pointOfContact');
  }

  // ── Identification info ──────────────────────────────────────────────────
  const ident = doc.ele('gmd:identificationInfo').ele('gmd:MD_DataIdentification');
  const citation = ident.ele('gmd:citation').ele('gmd:CI_Citation');
  charString(citation, 'gmd:title', c.titulo);

  const citDate = citation.ele('gmd:date').ele('gmd:CI_Date');
  citDate.ele('gmd:date').ele('gco:Date').txt(c.fecha || '');
  codeListEl(citDate, 'gmd:dateType', 'gmd:CI_DateTypeCode', 'publication');

  charString(ident, 'gmd:abstract', c.resumen);

  (c.palabras_clave || []).forEach((keyword) => {
    const kw = ident.ele('gmd:descriptiveKeywords').ele('gmd:MD_Keywords');
    charString(kw, 'gmd:keyword', keyword);
  });

  charString(ident, 'gmd:language', 'spa');

  if (c.bbox) {
    const extent = ident.ele('gmd:extent').ele('gmd:EX_Extent').ele('gmd:geographicElement').ele('gmd:EX_GeographicBoundingBox');
    decimalEl(extent, 'gmd:westBoundLongitude', c.bbox.oeste);
    decimalEl(extent, 'gmd:eastBoundLongitude', c.bbox.este);
    decimalEl(extent, 'gmd:southBoundLatitude', c.bbox.sur);
    decimalEl(extent, 'gmd:northBoundLatitude', c.bbox.norte);
  }

  if (c.escala_denominador) {
    const denominator = ident
      .ele('gmd:spatialResolution')
      .ele('gmd:MD_Resolution')
      .ele('gmd:equivalentScale')
      .ele('gmd:MD_RepresentativeFraction')
      .ele('gmd:denominator');
    denominator.ele('gco:Integer').txt(String(c.escala_denominador));
  }

  // ── Reference system ──────────────────────────────────────────────────────
  if (c.epsg) {
    const rsId = doc
      .ele('gmd:referenceSystemInfo')
      .ele('gmd:MD_ReferenceSystem')
      .ele('gmd:referenceSystemIdentifier')
      .ele('gmd:RS_Identifier');
    charString(rsId, 'gmd:code', `EPSG:${c.epsg}`);
    charString(rsId, 'gmd:codeSpace', 'EPSG');
  }

  // ── Distribution info (WMS / WFS online resources) ────────────────────────
  if (c.wms_url || c.wfs_url) {
    const transferOptions = doc
      .ele('gmd:distributionInfo')
      .ele('gmd:MD_Distribution')
      .ele('gmd:transferOptions')
      .ele('gmd:MD_DigitalTransferOptions');

    if (c.wms_url) {
      const online = transferOptions.ele('gmd:onLine').ele('gmd:CI_OnlineResource');
      online.ele('gmd:linkage').ele('gmd:URL').txt(c.wms_url);
      charString(online, 'gmd:protocol', 'OGC:WMS');
    }
    if (c.wfs_url) {
      const online2 = transferOptions.ele('gmd:onLine').ele('gmd:CI_OnlineResource');
      online2.ele('gmd:linkage').ele('gmd:URL').txt(c.wfs_url);
      charString(online2, 'gmd:protocol', 'OGC:WFS');
    }
  }

  // ── Data quality / lineage ─────────────────────────────────────────────────
  const dq = doc.ele('gmd:dataQualityInfo').ele('gmd:DQ_DataQuality');
  const scopeLevel = dq.ele('gmd:scope').ele('gmd:DQ_Scope').ele('gmd:level');
  scopeLevel
    .ele('gmd:MD_ScopeCode', { codeListValue: 'dataset', codeList: `${CODELIST_BASE}#MD_ScopeCode` })
    .txt('dataset');
  const lineage = dq.ele('gmd:lineage').ele('gmd:LI_Lineage');
  charString(lineage, 'gmd:statement', c.linaje || 'Generado por el módulo IDE Nacional (IDEP)');

  // ── Content info: reference to the ISO 19110 feature catalogue ────────────
  doc.ele('gmd:contentInfo').ele('gmd:MD_FeatureCatalogueDescription').ele('gmd:featureCatalogueCitation', { uuidref: fileIdentifier });

  return doc.end({ prettyPrint: true });
}

module.exports = { generar };
