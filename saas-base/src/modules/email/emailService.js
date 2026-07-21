'use strict'

const nodemailer = require('nodemailer')
const config = require('../../config')
const logger = require('../../config/logger')

// Transporter singleton
let transporter = null

// Deriva un texto-plano legible desde el HTML del correo. OJO: un simple
// strip de etiquetas (/<[^>]*>/g) deja INTACTO el contenido de <style>/<head>
// /<script>, así que el CSS de la plantilla branded se colaba como texto y
// aparecía en el snippet de la bandeja (Gmail muestra "body { margin:0; ... }").
// Primero eliminamos esos bloques completos, luego las etiquetas restantes,
// desescapamos las entidades comunes y colapsamos el espacio en blanco.
function htmlToText(html) {
  return String(html || '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function getTransporter() {
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host:   config.email.host,
    port:   config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
  })

  return transporter
}

/**
 * Envía un email.
 * @param {object} opts
 * @param {string|string[]} opts.to       - Destinatario(s)
 * @param {string} opts.subject           - Asunto
 * @param {string} opts.html              - Cuerpo HTML
 * @param {string} [opts.text]            - Cuerpo texto plano (fallback)
 * @param {string} [opts.fromName]        - Sobreescribe el nombre del remitente
 * @param {string|string[]} [opts.replyTo] - Dirección de respuesta
 * @param {string|string[]} [opts.cc]      - Con copia visible
 * @param {string|string[]} [opts.bcc]     - Con copia oculta
 * @param {Array}  [opts.attachments]     - Adjuntos en formato nodemailer
 *                                          [{filename, content, contentType}]
 */
async function sendEmail({ to, subject, html, text, fromName, replyTo, cc, bcc, attachments }) {
  const transport = getTransporter()
  if (!config.email.user || !config.email.pass) {
    throw new Error('SMTP no configurado (SMTP_USER/SMTP_PASS).')
  }
  if (!config.email.from) {
    throw new Error('EMAIL_FROM no configurado.')
  }

  const info = await transport.sendMail({
    from:    `"${fromName || config.email.fromName}" <${config.email.from}>`,
    to,
    cc,
    bcc,
    subject,
    html,
    text: text || htmlToText(html),
    replyTo,
    attachments,
  })

  logger.info('Email sent', { to, subject, messageId: info.messageId })
  return info
}

/**
 * Verifica la conexión SMTP.
 * Útil para el health check.
 */
async function verifyConnection() {
  const transport = getTransporter()
  await transport.verify()
  logger.info('SMTP connection verified')
}

module.exports = { sendEmail, verifyConnection }
