'use strict'

const { buildOrderBy } = require('../../src/utils/sortOrder')

const COLUMNS = {
  folio:   'so.order_number',
  fecha:   'so.created_at',
  cliente: 'bp.name',
  total:   'so.total_mxn',
}

describe('buildOrderBy', () => {
  test('usa el default cuando no se manda sortBy', () => {
    expect(buildOrderBy({ columns: COLUMNS, defaultKey: 'fecha', tiebreaker: 'so.id DESC' }))
      .toBe('so.created_at DESC NULLS LAST, so.id DESC')
  })

  test('resuelve la columna del allowlist y respeta asc', () => {
    expect(buildOrderBy({ sortBy: 'folio', sortDir: 'asc', columns: COLUMNS, defaultKey: 'fecha' }))
      .toBe('so.order_number ASC NULLS LAST')
  })

  test('una sortBy desconocida cae al default (anti-inyección)', () => {
    expect(buildOrderBy({ sortBy: 'so.created_at; DROP TABLE x', sortDir: 'desc', columns: COLUMNS, defaultKey: 'fecha' }))
      .toBe('so.created_at DESC NULLS LAST')
  })

  test('una sortDir basura se normaliza a DESC', () => {
    expect(buildOrderBy({ sortBy: 'total', sortDir: "asc'); DROP", columns: COLUMNS, defaultKey: 'fecha' }))
      .toBe('so.total_mxn DESC NULLS LAST')
  })

  test('no duplica el tiebreaker si coincide con la columna', () => {
    expect(buildOrderBy({ sortBy: 'fecha', columns: COLUMNS, defaultKey: 'fecha', tiebreaker: 'so.created_at' }))
      .toBe('so.created_at DESC NULLS LAST')
  })

  test('lanza si el defaultKey no existe en columns', () => {
    expect(() => buildOrderBy({ columns: COLUMNS, defaultKey: 'noexiste' })).toThrow()
  })
})
