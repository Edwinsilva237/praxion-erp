'use strict'

/**
 * Resiliencia del timbrado de complementos de pago ante caídas transitorias de
 * Facturapi/PAC (p.ej. el "Service Unavailable" 503 reportado en producción).
 * Pruebas PURAS de los helpers — sin BD ni red.
 */

const {
  _internal: { isTransientFacturapiError, createWithRetry, stampErrorMessage },
} = require('../../src/modules/invoicing/paymentComplementService')

function fakeErr({ message, status, statusCode, code, responseStatus } = {}) {
  const e = new Error(message || 'boom')
  if (status !== undefined) e.status = status
  if (statusCode !== undefined) e.statusCode = statusCode
  if (code !== undefined) e.code = code
  if (responseStatus !== undefined) e.response = { status: responseStatus }
  return e
}

describe('isTransientFacturapiError', () => {
  test('503 Service Unavailable (mensaje) es transitorio', () => {
    expect(isTransientFacturapiError(fakeErr({ message: 'Service Unavailable' }))).toBe(true)
  })
  test('status 503/502/504/429 son transitorios', () => {
    for (const s of [503, 502, 504, 429]) {
      expect(isTransientFacturapiError(fakeErr({ status: s }))).toBe(true)
    }
  })
  test('response.status y statusCode también se detectan', () => {
    expect(isTransientFacturapiError(fakeErr({ responseStatus: 503 }))).toBe(true)
    expect(isTransientFacturapiError(fakeErr({ statusCode: 502 }))).toBe(true)
  })
  test('códigos de red (ECONNRESET/ETIMEDOUT) son transitorios', () => {
    expect(isTransientFacturapiError(fakeErr({ code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientFacturapiError(fakeErr({ code: 'ETIMEDOUT' }))).toBe(true)
  })
  test('errores por DATOS (4xx) NO son transitorios', () => {
    expect(isTransientFacturapiError(fakeErr({ status: 400, message: 'UUID inválido' }))).toBe(false)
    expect(isTransientFacturapiError(fakeErr({ status: 422, message: 'RFC no válido' }))).toBe(false)
    expect(isTransientFacturapiError(fakeErr({ status: 401 }))).toBe(false)
  })
})

describe('createWithRetry', () => {
  test('reintenta ante 503 y tiene éxito en el 2º intento', async () => {
    let calls = 0
    const facturapi = {
      invoices: {
        create: jest.fn(async () => {
          calls++
          if (calls === 1) throw fakeErr({ message: 'Service Unavailable', status: 503 })
          return { id: 'comp_1', uuid: 'UUID-OK' }
        }),
      },
    }
    const res = await createWithRetry(facturapi, {}, { baseDelayMs: 1, label: 'E-1' })
    expect(res.uuid).toBe('UUID-OK')
    expect(calls).toBe(2)
  })

  test('NO reintenta ante error por datos (4xx): lanza al primer intento', async () => {
    let calls = 0
    const facturapi = {
      invoices: {
        create: jest.fn(async () => { calls++; throw fakeErr({ status: 400, message: 'RFC inválido' }) }),
      },
    }
    await expect(createWithRetry(facturapi, {}, { baseDelayMs: 1 })).rejects.toThrow('RFC inválido')
    expect(calls).toBe(1)
  })

  test('agota los reintentos ante 503 persistente y propaga el último error', async () => {
    let calls = 0
    const facturapi = {
      invoices: {
        create: jest.fn(async () => { calls++; throw fakeErr({ message: 'Service Unavailable', status: 503 }) }),
      },
    }
    await expect(
      createWithRetry(facturapi, {}, { attempts: 3, baseDelayMs: 1 })
    ).rejects.toThrow('Service Unavailable')
    expect(calls).toBe(3)
  })
})

describe('stampErrorMessage', () => {
  test('transitorio: explica que es temporal y que el pago NO se registró', () => {
    const msg = stampErrorMessage(fakeErr({ message: 'Service Unavailable', status: 503 }), 'E-4546')
    expect(msg).toMatch(/no está disponible/i)
    expect(msg).toMatch(/NO se registró/i)
    expect(msg).toContain('E-4546')
  })
  test('error por datos: mensaje técnico con el folio', () => {
    const msg = stampErrorMessage(fakeErr({ status: 400, message: 'UUID inválido' }), 'E-4546')
    expect(msg).toContain('E-4546')
    expect(msg).toContain('UUID inválido')
  })
})
