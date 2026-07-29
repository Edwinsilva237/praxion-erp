'use strict'

/**
 * Resiliencia del pool de Postgres cuando la conexión muere con queries EN VUELO.
 *
 * Reproduce la caída de producción del 2026-07-29: Render Postgres cortó todas
 * las conexiones de golpe ("Connection terminated unexpectedly") y praxion-api
 * salió con status 1 → todos los tenants con timeouts mientras Render reiniciaba.
 *
 * Mecanismo: pg-pool le quita al cliente su `idleListener` mientras está
 * PRESTADO (`_acquireClient`), así que el cliente queda sin listener de 'error'.
 * Al morir la conexión, `pg` hace `client.emit('error')` y un EventEmitter sin
 * listener de 'error' hace que Node lance la excepción → muere el proceso.
 * `attachCheckoutErrorGuard` (src/db/index.js) absorbe ese evento.
 *
 * Si esta prueba REGRESA, no falla con un expect: se lleva al worker de jest
 * completo (que es justo el síntoma que estamos previniendo).
 */

const { pool, query, getClient, withTransaction } = require('../../src/db')

afterAll(async () => { await pool.end() })

test('un cliente PRESTADO trae listener de error (el proceso no muere si cae la conexión)', async () => {
  const client = await getClient()
  try {
    // pg-pool quitó su idleListener al prestar; el nuestro debe estar puesto.
    expect(client.listenerCount('error')).toBeGreaterThan(0)
  } finally {
    client.release()
  }
})

test('el listener se RETIRA al liberar (no se acumulan en clientes reciclados)', async () => {
  const first = await getClient()
  const during = first.listenerCount('error')
  first.release()

  // Al liberar, pg-pool vuelve a poner su propio idleListener y el nuestro
  // se retira → el conteo no crece con cada préstamo del mismo cliente.
  const second = await getClient()
  try {
    expect(second.listenerCount('error')).toBe(during)
  } finally {
    second.release()
  }
})

test('la conexión MUERE con el cliente prestado: el proceso sobrevive y el pool se recupera', async () => {
  const client = await getClient()

  // Simula el corte de Render: destruye el socket por debajo del cliente.
  // Sin el guard, el emit('error') resultante mataría el proceso entero.
  client.connection.stream.destroy(new Error('simulación: conexión cortada'))

  // Deja correr el ciclo de eventos para que pg procese el 'end'/'error'.
  await new Promise((resolve) => setTimeout(resolve, 150))

  // La query en vuelo/posterior sobre ESE cliente falla (correcto), pero sin
  // tumbar el proceso.
  await expect(client.query('SELECT 1')).rejects.toBeDefined()
  try { client.release() } catch { /* el pool ya lo descartó */ }

  // Llegar aquí ya prueba que el proceso vive. Y el pool sigue sirviendo con
  // una conexión nueva.
  const { rows } = await query('SELECT 1 AS ok')
  expect(rows[0].ok).toBe(1)
})

// ── Reintento cuando la BD está reiniciando ────────────────────────────────
// Render reinició el Postgres el 2026-07-29 20:29 UTC y el servidor rechazó
// conexiones unos segundos con 57P03 ("the database system is in recovery
// mode") → TODA petición murió con 500 aunque el proceso estaba sano. El
// reintento vive en la ADQUISICIÓN de la conexión (la query no se ejecutó, así
// que no hay riesgo de duplicar escrituras).
function recoveryModeError() {
  const err = new Error('the database system is in recovery mode')
  err.code = '57P03'
  return err
}

afterEach(() => { jest.restoreAllMocks() })

test('BD en recovery mode: reintenta y la query termina bien', async () => {
  const real = pool.connect.bind(pool)
  let intentos = 0
  jest.spyOn(pool, 'connect').mockImplementation(() => {
    intentos++
    // Los 2 primeros intentos fallan como lo hizo Render; el 3º conecta.
    return intentos <= 2 ? Promise.reject(recoveryModeError()) : real()
  })

  const { rows } = await query('SELECT 1 AS ok')
  expect(rows[0].ok).toBe(1)
  expect(intentos).toBe(3)
})

test('un error NO transitorio no se reintenta (falla de inmediato)', async () => {
  const err = new Error('password authentication failed')
  err.code = '28P01'
  const spy = jest.spyOn(pool, 'connect').mockRejectedValue(err)

  await expect(query('SELECT 1')).rejects.toMatchObject({ code: '28P01' })
  expect(spy).toHaveBeenCalledTimes(1)   // sin reintentos inútiles
})

test('si la BD sigue caída, se rinde dentro del presupuesto (no cuelga)', async () => {
  jest.spyOn(pool, 'connect').mockRejectedValue(recoveryModeError())

  const t0 = Date.now()
  await expect(query('SELECT 1')).rejects.toMatchObject({ code: '57P03' })
  const elapsed = Date.now() - t0

  // Presupuesto de 3s con backoff creciente (250+500+1000): se rinde solo,
  // muy por debajo del timeout de 15s del frontend, en vez de insistir para
  // siempre.
  expect(elapsed).toBeLessThan(3000)
})

test('getClient/withTransaction también reintentan al adquirir', async () => {
  const real = pool.connect.bind(pool)
  let intentos = 0
  jest.spyOn(pool, 'connect').mockImplementation(() => {
    intentos++
    return intentos === 1 ? Promise.reject(recoveryModeError()) : real()
  })

  const r = await withTransaction((client) => client.query('SELECT 1 AS ok'))
  expect(r.rows[0].ok).toBe(1)
  expect(intentos).toBe(2)
})

test('caídas repetidas no fugan conexiones del pool', async () => {
  // Si un cliente roto se quedara "prestado para siempre", cada ciclo comería
  // un slot del pool hasta agotarlo (y el siguiente checkout colgaría).
  for (let i = 0; i < 5; i++) {
    const client = await getClient()
    client.connection.stream.destroy(new Error(`simulación ciclo ${i}`))
    await new Promise((resolve) => setTimeout(resolve, 60))
    try { client.release() } catch { /* el pool ya lo descartó */ }
  }

  // Nada prestado tras los ciclos y el pool sigue atendiendo.
  expect(pool.totalCount - pool.idleCount).toBe(0)
  const { rows } = await query('SELECT 1 AS ok')
  expect(rows[0].ok).toBe(1)
})

test('withTransaction sobre una conexión muerta rechaza sin tumbar el proceso', async () => {
  await expect(withTransaction(async (client) => {
    client.connection.stream.destroy(new Error('simulación: conexión cortada'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    return client.query('SELECT 1')
  })).rejects.toBeDefined()

  // El pool se recupera para el siguiente uso.
  const { rows } = await query('SELECT 1 AS ok')
  expect(rows[0].ok).toBe(1)
})
