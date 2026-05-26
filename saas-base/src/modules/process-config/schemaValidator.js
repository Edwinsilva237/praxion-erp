'use strict'

/**
 * SaaS v2 — Validador de meta-schema para tenant_product_kinds.
 *
 * Los campos `attribute_schema` y `capture_schema` de tenant_product_kinds son
 * JSONB con un wrapper de versión: `{ version: N, fields: [...] }`. Este módulo
 * valida que dichos JSONB cumplan con un meta-schema fijo (JSON Schema) antes
 * de persistirse.
 *
 * Tipos soportados en fields:
 *   text, number, boolean, select, multiselect, date, color
 *
 * `select` y `multiselect` REQUIEREN `options`.
 *
 * UI hints (ui_hint, presets, etc.) se aceptan como propiedades adicionales
 * sin validación — son hints para el frontend, el backend no los interpreta.
 *
 * Referencia: §2.2.8 del 00-design.md.
 */

const Ajv = require('ajv')

const FIELD_TYPES = ['text', 'number', 'boolean', 'select', 'multiselect', 'date', 'color']

// Meta-schema de un campo individual.
const FIELD_SCHEMA = {
  type: 'object',
  required: ['code', 'label', 'type'],
  additionalProperties: true,  // permite ui_hint, presets, etc.
  properties: {
    code: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_]*$',
      maxLength: 60,
    },
    label: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
    },
    type: {
      type: 'string',
      enum: FIELD_TYPES,
    },
    required: { type: 'boolean' },
    deprecated: { type: 'boolean' },
    lot_critical: { type: 'boolean' },
    unit_code: { type: 'string' },
    default: {},  // any
    options: {
      type: 'array',
      items: { type: ['string', 'number'] },
    },
    validation: {
      type: 'object',
      additionalProperties: true,
      properties: {
        min: { type: 'number' },
        max: { type: 'number' },
        pattern: { type: 'string' },
        minLength: { type: 'integer', minimum: 0 },
        maxLength: { type: 'integer', minimum: 0 },
      },
    },
  },
  allOf: [
    {
      // Si type es select|multiselect → options requerido y no vacío
      if: { properties: { type: { enum: ['select', 'multiselect'] } } },
      then: {
        required: ['options'],
        properties: { options: { minItems: 1 } },
      },
    },
  ],
}

// Meta-schema del wrapper completo.
const WRAPPER_SCHEMA = {
  type: 'object',
  required: ['version', 'fields'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', minimum: 1 },
    fields: {
      type: 'array',
      items: FIELD_SCHEMA,
    },
  },
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validateWrapperFn = ajv.compile(WRAPPER_SCHEMA)

/**
 * Valida un schema completo (wrapper + fields). Lanza error con .status=400 si inválido.
 * También valida que los `code` sean únicos dentro del array.
 *
 * @param {any} schema  El JSONB ya parseado.
 * @param {string} label  'attribute_schema' o 'capture_schema' (para mensaje de error).
 */
function validateSchema(schema, label) {
  if (schema === null || schema === undefined) {
    throw badReq(`${label} no puede ser null.`)
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    throw badReq(`${label} debe ser un objeto { version, fields }.`)
  }

  const ok = validateWrapperFn(schema)
  if (!ok) {
    const msg = validateWrapperFn.errors
      .map(e => `${e.instancePath || '(root)'}: ${e.message}`)
      .join('; ')
    throw badReq(`${label} inválido: ${msg}`)
  }

  // Validar codes únicos en fields
  const codes = schema.fields.map(f => f.code)
  const dups = codes.filter((c, i) => codes.indexOf(c) !== i)
  if (dups.length > 0) {
    throw badReq(`${label} tiene codes duplicados: ${[...new Set(dups)].join(', ')}.`)
  }
}

/**
 * Schema vacío default — { version: 1, fields: [] }.
 */
function emptySchema() {
  return { version: 1, fields: [] }
}

/**
 * Dado un schema actual y un schema nuevo (sin version), genera el nuevo
 * objeto con version auto-incrementada. Si los fields son semánticamente
 * idénticos (deep-equal con keys ordenadas), mantiene la versión actual.
 *
 * Nota: la comparación es canónica porque PostgreSQL JSONB reordena keys
 * arbitrariamente al persistir, así que JSON.stringify directo daría falsos
 * positivos de "cambio".
 */
function withBumpedVersion(currentSchema, newSchemaFromUser) {
  const incoming = { ...newSchemaFromUser }
  const incomingFields = incoming.fields || []
  const currentVersion = (currentSchema && currentSchema.version) || 1
  const currentFields = (currentSchema && currentSchema.fields) || []

  const sameFields = canonicalJSON(currentFields) === canonicalJSON(incomingFields)
  const version = sameFields ? currentVersion : currentVersion + 1

  return { version, fields: incomingFields }
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = canonicalize(value[k])
      return acc
    }, {})
  }
  return value
}

function badReq(msg) { const e = new Error(msg); e.status = 400; return e }

module.exports = {
  FIELD_TYPES,
  validateSchema,
  emptySchema,
  withBumpedVersion,
}
