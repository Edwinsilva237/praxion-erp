'use strict'

const { createLogger, format, transports } = require('winston')
const config = require('./index')

const logger = createLogger({
  level: config.isTest() ? 'silent' : config.isDev() ? 'debug' : 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    config.isDev()
      ? format.combine(format.colorize(), format.simple())
      : format.json()
  ),
  transports: [new transports.Console()],
})

module.exports = logger
