'use strict';

/**
 * iso19110Service.js
 * Generates an ISO 19110 XML feature catalogue document from a catalogue
 * object (ide.feature_catalogues + ide.feature_types + ide.feature_attributes
 * + ide.attribute_domain_values, already joined by the caller).
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

/**
 * Build an ISO 19110 XML feature catalogue.
 *
 * @param {object} catalogue
 * @param {string} catalogue.nombre
 * @param {string} [catalogue.scope]
 * @param {string} [catalogue.version_catalogo]
 * @param {string} [catalogue.productor]
 * @param {Array}  catalogue.feature_types  [{nombre, definicion, alias, feature_attributes:[...]}]
 * @returns {string} pretty-printed ISO 19110 XML
 */
function generar(catalogue) {
  const cat = catalogue || {};
  const featureTypes = cat.feature_types || [];

  const rootAttrs = {
    'xmlns:gfc': 'http://www.isotc211.org/2005/gfc',
    'xmlns:gmx': 'http://www.isotc211.org/2005/gmx',
    'xmlns:gmd': 'http://www.isotc211.org/2005/gmd',
    'xmlns:gco': 'http://www.isotc211.org/2005/gco',
    'xmlns:gml': 'http://www.opengis.net/gml/3.2',
    'xmlns:xlink': 'http://www.w3.org/1999/xlink',
  };
  if (cat.uuid) rootAttrs.uuid = cat.uuid;

  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('gfc:FC_FeatureCatalogue', rootAttrs);

  charString(doc, 'gmx:name', cat.nombre || '');
  charString(doc, 'gmx:scope', cat.scope || '');
  charString(doc, 'gmx:versionNumber', cat.version_catalogo || '1.0');

  if (cat.productor) {
    const producer = doc.ele('gmx:producer').ele('gmd:CI_ResponsibleParty');
    charString(producer, 'gmd:organisationName', cat.productor);
    const role = producer.ele('gmd:role');
    role
      .ele('gmd:CI_RoleCode', { codeListValue: 'custodian', codeList: `${CODELIST_BASE}#CI_RoleCode` })
      .txt('custodian');
  }

  featureTypes.forEach((ft) => {
    const ftEl = doc.ele('gfc:featureType').ele('gfc:FC_FeatureType');
    charString(ftEl, 'gfc:typeName', ft.nombre || '');
    charString(ftEl, 'gfc:definition', ft.definicion || '');
    ftEl.ele('gfc:isAbstract').ele('gco:Boolean').txt('false');
    if (ft.alias) charString(ftEl, 'gfc:aliases', ft.alias);

    const attrs = ft.feature_attributes || [];
    attrs.forEach((attr) => {
      const attrEl = ftEl.ele('gfc:carrierOfCharacteristics').ele('gfc:FC_FeatureAttribute');
      charString(attrEl, 'gfc:memberName', attr.nombre || '');
      charString(attrEl, 'gfc:definition', attr.definicion || '');
      if (attr.alias) charString(attrEl, 'gfc:aliases', attr.alias);
      if (attr.tipo_dato) charString(attrEl, 'gfc:valueType', attr.tipo_dato);

      const range = attrEl.ele('gfc:cardinality').ele('gco:Multiplicity').ele('gco:range').ele('gco:MultiplicityRange');
      range.ele('gco:lower').ele('gco:Integer').txt(attr.obligatorio ? '1' : '0');
      range.ele('gco:upper').ele('gco:UnlimitedInteger', { isInfinite: 'false' }).txt('1');

      const dominio = (attr.tipo_dominio || '').toLowerCase();
      if (dominio === 'enumerado' || dominio === 'codelist') {
        const valores = attr.attribute_domain_values || [];
        valores.forEach((dv) => {
          const lv = attrEl.ele('gfc:listedValue').ele('gfc:FC_ListedValue');
          charString(lv, 'gfc:label', dv.codigo || '');
          charString(lv, 'gfc:definition', dv.descripcion || '');
        });
      }
    });
  });

  return doc.end({ prettyPrint: true });
}

module.exports = { generar };
