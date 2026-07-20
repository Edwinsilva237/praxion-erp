'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Módulo "Comunicados": el tenant envía un aviso (texto + N adjuntos libres) por
// correo a sus CLIENTES, PROVEEDORES y/o correos MANUALES. UN correo INDIVIDUAL
// por socio (a todos sus contactos con email) — no se cruzan entre socios; los
// manuales van 1 correo por dirección. La bitácora (communication_sends /
// _recipients) es el comprobante de cada envío. Reusa la plomería branded de la
// distribución fiscal vía utils/emailBroadcast + email/templates. Ver
// [[communications-module-roadmap]].
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../db')
const config = require('../../config')
const attachmentService = require('../attachments/attachmentService')
const { enqueueEmail } = require('../../queues/emailQueue')
const { audit } = require('../../utils/audit')
const { communicationEmail } = require('../email/templates')
const { normalizeManualEmails, resolveIssuerName, getTenantEmailBranding } = require('../../utils/emailBroadcast')

// Espaciado entre correos (ms) para no saturar Workspace en lotes grandes.
const SEND_STAGGER_MS = 300
// Fase 1 (envío SÍNCRONO): capamos la audiencia al rango probado para no
// timeout-ear la petición. La cola async (Fase 2) levanta este tope.
const MAX_RECIPIENTS = 300

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// ─── Socios (clientes/proveedores) activos con contacto(s) con email ─────────
// Devuelve, para el tipo pedido, la lista de socios con sus correos. `ids`
// (opcional) acota; si es undefined se traen TODOS los de ese tipo (para el
// preview). Excluye ocasionales.
async function loadPartners({ tenantId, partnerTypes, ids }) {
  const params = [tenantId, partnerTypes]
  let idFilter = ''
  // Distinción clave: ids === [] (selección vacía) = NINGUNO; undefined = todos.
  if (Array.isArray(ids)) {
    if (ids.length === 0) return { withEmail: [], withoutEmail: [] }
    params.push(ids)
    idFilter = `AND bp.id = ANY($${params.length}::uuid[])`
  }

  const { rows: partners } = await query(
    `SELECT bp.id, COALESCE(NULLIF(bp.tax_name, ''), bp.name) AS name
       FROM business_partners bp
      WHERE bp.tenant_id = $1
        AND bp.type = ANY($2)
        AND bp.is_active = true
        AND COALESCE(bp.is_occasional, false) = false
        ${idFilter}
      ORDER BY name`,
    params
  )
  if (partners.length === 0) return { withEmail: [], withoutEmail: [] }

  const pIds = partners.map(p => p.id)
  const { rows: contacts } = await query(
    `SELECT business_partner_id, LOWER(TRIM(email)) AS email
       FROM business_partner_contacts
      WHERE business_partner_id = ANY($1::uuid[])
        AND email IS NOT NULL AND TRIM(email) <> ''`,
    [pIds]
  )
  const byPartner = {}
  for (const c of contacts) {
    (byPartner[c.business_partner_id] || (byPartner[c.business_partner_id] = new Set())).add(c.email)
  }

  const withEmail = []
  const withoutEmail = []
  for (const p of partners) {
    const emails = Array.from(byPartner[p.id] || [])
    if (emails.length > 0) withEmail.push({ id: p.id, name: p.name, emails })
    else withoutEmail.push({ id: p.id, name: p.name })
  }
  return { withEmail, withoutEmail }
}

// ─── Preview: TODOS los clientes y proveedores con email (para el selector) ───
async function previewRecipients({ tenantId }) {
  const [cli, prov] = await Promise.all([
    loadPartners({ tenantId, partnerTypes: ['customer', 'both'] }),
    loadPartners({ tenantId, partnerTypes: ['supplier', 'both'] }),
  ])
  return {
    clients:            cli.withEmail,
    clientsWithoutEmail: cli.withoutEmail,
    suppliers:          prov.withEmail,
    suppliersWithoutEmail: prov.withoutEmail,
  }
}

// ─── Enviar un comunicado ────────────────────────────────────────────────────
// files: [{ originalname, buffer, mimetype, size }] (de multer, en memoria).
async function distribute({
  tenantId, subject, message, category,
  clientIds, supplierIds, manualEmails, files = [],
  sentBy, ipAddress, userAgent,
}) {
  const finalSubject = String(subject || '').trim()
  if (!finalSubject) throw createError(400, 'El asunto es requerido.')

  // 1) Adjuntos: guard de tamaño total (los correos topan ~25 MB; usamos el
  //    límite de subida configurado como tope conservador del TOTAL).
  const totalBytes = files.reduce((n, f) => n + (f.size || (f.buffer ? f.buffer.length : 0)), 0)
  const maxBytes = config.uploads.maxSizeMb * 1024 * 1024
  if (totalBytes > maxBytes) {
    throw createError(400, `Los adjuntos superan ${config.uploads.maxSizeMb} MB en total. Reduce o divide el envío.`)
  }

  // 2) Destinatarios: clientes + proveedores SELECCIONADOS + manuales, con DEDUPE
  //    global por correo (nadie recibe dos copias). OJO: en el ENVÍO, una lista
  //    ausente = NINGUNO (no "todos"); solo el preview trae todos. Por eso
  //    normalizamos undefined → [] antes de consultar.
  const clientSel   = Array.isArray(clientIds) ? clientIds : []
  const supplierSel = Array.isArray(supplierIds) ? supplierIds : []
  const [cli, prov] = await Promise.all([
    loadPartners({ tenantId, partnerTypes: ['customer', 'both'], ids: clientSel }),
    loadPartners({ tenantId, partnerTypes: ['supplier', 'both'], ids: supplierSel }),
  ])
  const manual = normalizeManualEmails(manualEmails)

  const seen = new Set()
  const dedupe = (emails) => {
    const out = []
    for (const e of emails) { if (!seen.has(e)) { seen.add(e); out.push(e) } }
    return out
  }
  // Clientes primero, luego proveedores; un socio 'both' seleccionado en ambos
  // lados no duplica gracias al Set compartido.
  const clientR   = cli.withEmail.map(c => ({ ...c, type: 'customer', emails: dedupe(c.emails) })).filter(c => c.emails.length)
  const supplierR = prov.withEmail.map(s => ({ ...s, type: 'supplier', emails: dedupe(s.emails) })).filter(s => s.emails.length)
  const manualR   = dedupe(manual)

  const recipientCount = clientR.reduce((n, c) => n + c.emails.length, 0)
                       + supplierR.reduce((n, s) => n + s.emails.length, 0)
                       + manualR.length
  if (recipientCount === 0) {
    throw createError(400, 'No hay destinatarios: selecciona clientes/proveedores con correo o escribe correos manuales.')
  }
  if (recipientCount > MAX_RECIPIENTS) {
    throw createError(400, `El envío supera el máximo de ${MAX_RECIPIENTS} destinatarios por comunicado. Divide la audiencia (el envío masivo llegará en una próxima versión).`)
  }

  // 3) Emisor (razón social) + branding (color + logo inline).
  const tenantName = await resolveIssuerName(tenantId)
  const { brandColor, logoCid, logoAttachment } = await getTenantEmailBranding(tenantId)

  // 4) Adjuntos del correo (los archivos del aviso + el logo inline).
  const emailAttachments = files.map(f => ({
    filename: f.originalname, content: f.buffer, contentType: f.mimetype,
  }))
  if (logoAttachment) emailAttachments.push(logoAttachment)
  const attachmentLabels = files.map(f => f.originalname)

  // 5) Batch (bitácora).
  const { rows: sendRows } = await query(
    `INSERT INTO communication_sends
       (tenant_id, subject, message, category, attachment_count,
        client_count, supplier_count, manual_count, recipient_count, status, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10)
     RETURNING id`,
    [tenantId, finalSubject, String(message || '').trim() || null, category || null,
     files.length, clientR.length, supplierR.length, manualR.length, recipientCount, sentBy || null]
  )
  const sendId = sendRows[0].id

  // 6) Persistir los adjuntos ligados al envío (para verlos en el historial).
  //    Best-effort: si falla el guardado, el correo igual salió con el adjunto.
  for (const f of files) {
    try {
      await attachmentService.saveAttachment({
        tenantId, entityType: 'communication', entityId: sendId, category: 'communication',
        originalFilename: f.originalname, buffer: f.buffer, mimeType: f.mimetype,
        uploadedBy: sentBy || null,
      })
    } catch (_) { /* no bloquear el envío por el respaldo del adjunto */ }
  }

  // 7) Enviar: un correo por socio (a sus contactos) + uno por correo manual.
  let failed = 0
  let idx = 0

  async function sendOne({ to, name, type, partnerId }) {
    const html = communicationEmail({
      tenantName, recipientName: name, subject: finalSubject, message,
      attachmentLabels, brandColor, logoCid,
    })
    let recFailed = false
    let errMsg = null
    try {
      await enqueueEmail(
        { to, subject: finalSubject, html, attachments: emailAttachments, tenantId },
        { delay: idx * SEND_STAGGER_MS }
      )
    } catch (err) {
      recFailed = true
      errMsg = err?.message || 'Error al enviar'
    }
    idx++
    const emails = Array.isArray(to) ? to : [to]
    for (const email of emails) {
      if (recFailed) failed++
      await query(
        `INSERT INTO communication_send_recipients
           (send_id, tenant_id, partner_id, partner_name, partner_type, email, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sendId, tenantId, partnerId || null, name || null, type, email,
         recFailed ? 'failed' : 'queued', errMsg]
      )
    }
  }

  for (const c of clientR)   await sendOne({ to: c.emails, name: c.name, type: 'customer', partnerId: c.id })
  for (const s of supplierR) await sendOne({ to: s.emails, name: s.name, type: 'supplier', partnerId: s.id })
  for (const email of manualR) await sendOne({ to: email, name: null, type: 'manual', partnerId: null })

  // 8) Estado final + auditoría.
  const status = failed === 0 ? 'completed' : 'partial'
  await query(`UPDATE communication_sends SET status = $1 WHERE id = $2`, [status, sendId])

  try {
    await audit({
      tenantId, userId: sentBy,
      action: 'communications.sent', resource: 'communication_sends', resourceId: sendId,
      payload: { subject: finalSubject, category, recipientCount,
                 clientCount: clientR.length, supplierCount: supplierR.length,
                 manualCount: manualR.length, attachmentCount: files.length, failed },
      ipAddress, userAgent,
    })
  } catch (_) { /* la auditoría no debe romper el envío */ }

  return {
    sendId, recipientCount, clientCount: clientR.length, supplierCount: supplierR.length,
    manualCount: manualR.length, attachmentCount: files.length, failedCount: failed, status,
  }
}

// ─── Historial ────────────────────────────────────────────────────────────────
async function listSends({ tenantId, limit = 50 }) {
  const { rows } = await query(
    `SELECT s.id, s.subject, s.category, s.attachment_count,
            s.client_count, s.supplier_count, s.manual_count, s.recipient_count,
            s.status, s.created_at, u.full_name AS sent_by_name,
            COUNT(r.id) FILTER (WHERE r.status = 'failed') AS failed_count
       FROM communication_sends s
       LEFT JOIN users u ON u.id = s.sent_by
       LEFT JOIN communication_send_recipients r ON r.send_id = s.id
      WHERE s.tenant_id = $1
      GROUP BY s.id, u.full_name
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [tenantId, Math.min(Number(limit) || 50, 200)]
  )
  return rows
}

async function getSend({ tenantId, sendId }) {
  const { rows: sr } = await query(
    `SELECT s.*, u.full_name AS sent_by_name
       FROM communication_sends s
       LEFT JOIN users u ON u.id = s.sent_by
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [sendId, tenantId]
  )
  if (!sr[0]) return null
  const { rows: recipients } = await query(
    `SELECT id, partner_id, partner_name, partner_type, email, status, error, created_at
       FROM communication_send_recipients
      WHERE send_id = $1 AND tenant_id = $2
      ORDER BY partner_type, partner_name, email`,
    [sendId, tenantId]
  )
  const attachments = await attachmentService.listAttachments({
    tenantId, entityType: 'communication', entityId: sendId, category: 'communication',
  })
  return { ...sr[0], recipients, attachments }
}

module.exports = { previewRecipients, distribute, listSends, getSend }
