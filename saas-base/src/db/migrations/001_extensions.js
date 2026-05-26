'use strict'

const up = `
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
`

const down = `
  -- No se eliminan extensiones
`

module.exports = { up, down }
