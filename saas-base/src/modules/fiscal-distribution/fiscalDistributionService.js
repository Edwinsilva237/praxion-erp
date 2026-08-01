'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Distribución de documentos fiscales (CSF + Opinión 32-D) a clientes.
//
// El tenant sube su Constancia de Situación Fiscal (CSF) y su Opinión de
// Cumplimiento (art. 32-D CFF) —descargadas del SAT en PDF— y el ERP las envía
// por correo a sus clientes: UN correo INDIVIDUAL por cliente (no se cruzan
// entre sí = privacidad), a TODOS los contactos con email de ese cliente.
//
// Los docs se guardan como attachments a nivel tenant (entity_type='tenant',
// categorías fiscal_csf/fiscal_32d, reemplazables). La bitácora de cada envío
// vive en fiscal_doc_sends + fiscal_doc_send_recipients (comprobante de
// cumplimiento). Ver [[fiscal-docs-distribution-plan]].
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../db')
const attachmentService = require('../attachments/attachmentService')
const storage = require('../../utils/storage')
const { sendEmail } = require('../email/emailService')
const { audit } = require('../../utils/audit')
const { fiscalDocsEmail } = require('../email/templates')
const { normalizeManualEmails, resolveIssuerName, getTenantEmailBranding } = require('../../utils/emailBroadcast')
const config = require('../../config')

const ENTITY_TYPE = 'tenant'
const CATEGORY = { csf: 'fiscal_csf', opinion: 'fiscal_32d' }
const DISPATCH_QUEUE = 'fiscal-docs.dispatch'
// Espaciado entre correos (ms) para no saturar Workspace en lotes grandes.
const SEND_STAGGER_MS = 300

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Encola el fan-out en pg-boss. Require PEREZOSO + guard de test: pg-boss es
// ESM y jest no lo transforma, así que en tests devolvemos null → envío inline
// (mismo patrón que Comunicados).
async function tryEnqueueDispatch(payload) {
  if (config.env === 'test') return null
  try {
    const { enqueue } = require('../../utils/pgboss')
    return await enqueue(DISPATCH_QUEUE, payload,
      { retryLimit: 5, retryDelay: 30, expireInSeconds: 900 })
  } catch (_) { return null }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function docTypeToCategory(docType) {
  const cat = CATEGORY[docType]
  if (!cat) throw createError(400, `docType inválido: ${docType}. Usa 'csf' u 'opinion'.`)
  return cat
}

// ─── Subir / reemplazar un documento fiscal del tenant ───────────────────────
async function uploadFiscalDoc({ tenantId, docType, buffer, originalFilename, mimeType, uploadedBy }) {
  const category = docTypeToCategory(docType)
  // replaceCategory: solo un documento vigente por tipo (el nuevo pisa al viejo).
  return attachmentService.saveAttachment({
    tenantId,
    entityType: ENTITY_TYPE,
    entityId:   tenantId,
    category,
    originalFilename,
    buffer,
    mimeType,
    uploadedBy,
    replaceCategory: true,
  })
}

// ─── Consultar los documentos fiscales cargados ──────────────────────────────
async function getFiscalDocs({ tenantId }) {
  const [csfList, opinionList] = await Promise.all([
    attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category: CATEGORY.csf }),
    attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category: CATEGORY.opinion }),
  ])
  return { csf: csfList[0] || null, opinion: opinionList[0] || null }
}

// ─── Metadata + key de un doc para servirlo/descargarlo ──────────────────────
async function getFiscalDocForServe({ tenantId, docType }) {
  const category = docTypeToCategory(docType)
  const list = await attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category })
  if (!list[0]) return null
  return attachmentService.getAttachmentInfo({ tenantId, attachmentId: list[0].id })
}

// ─── Eliminar un doc fiscal ──────────────────────────────────────────────────
async function deleteFiscalDoc({ tenantId, docType }) {
  const category = docTypeToCategory(docType)
  const list = await attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category })
  if (!list[0]) return null
  return attachmentService.deleteAttachment({ tenantId, attachmentId: list[0].id })
}

// ─── Armar destinatarios: clientes activos con contacto(s) con email ─────────
// Devuelve por cliente sus correos. `partnerIds` (opcional) acota la selección.
async function buildRecipients({ tenantId, partnerIds }) {
  // Semántica: partnerIds `undefined` = TODOS los clientes activos; un array VACÍO
  // = NINGUNO (el usuario deseleccionó todo y solo manda a correos manuales). Sin
  // esta distinción, `[]` caería en "sin filtro" = enviar a todos por accidente.
  if (Array.isArray(partnerIds) && partnerIds.length === 0) {
    return { clients: [], clientsWithoutEmail: [] }
  }
  const params = [tenantId]
  let idFilter = ''
  if (Array.isArray(partnerIds) && partnerIds.length > 0) {
    params.push(partnerIds)
    idFilter = `AND bp.id = ANY($${params.length}::uuid[])`
  }

  // Clientes activos (customer/both), NO ocasionales.
  const { rows: partners } = await query(
    `SELECT bp.id, COALESCE(NULLIF(bp.tax_name, ''), bp.name) AS name
       FROM business_partners bp
      WHERE bp.tenant_id = $1
        AND bp.type IN ('customer','both')
        AND bp.is_active = true
        AND COALESCE(bp.is_occasional, false) = false
        ${idFilter}
      ORDER BY name`,
    params
  )
  if (partners.length === 0) return { clients: [], clientsWithoutEmail: [] }

  const ids = partners.map(p => p.id)
  const { rows: contacts } = await query(
    `SELECT business_partner_id, LOWER(TRIM(email)) AS email
       FROM business_partner_contacts
      WHERE business_partner_id = ANY($1::uuid[])
        AND email IS NOT NULL AND TRIM(email) <> ''`,
    [ids]
  )
  const emailsByPartner = {}
  for (const c of contacts) {
    if (!emailsByPartner[c.business_partner_id]) emailsByPartner[c.business_partner_id] = new Set()
    emailsByPartner[c.business_partner_id].add(c.email)
  }

  const clients = []
  const clientsWithoutEmail = []
  for (const p of partners) {
    const emails = Array.from(emailsByPartner[p.id] || [])
    if (emails.length > 0) clients.push({ id: p.id, name: p.name, emails })
    else clientsWithoutEmail.push({ id: p.id, name: p.name })
  }
  return { clients, clientsWithoutEmail }
}

// ─── Preview de conteos antes de enviar ──────────────────────────────────────
async function previewRecipients({ tenantId, partnerIds }) {
  const { clients, clientsWithoutEmail } = await buildRecipients({ tenantId, partnerIds })
  const recipientCount = clients.reduce((n, c) => n + c.emails.length, 0)
  return {
    clientCount: clients.length,
    recipientCount,
    clients,
    clientsWithoutEmail,
  }
}

// ─── Enviar los docs fiscales a los clientes ─────────────────────────────────
// Pre-inserta la bitácora (batch + destinatarios en 'queued') y ENCOLA el
// fan-out en pg-boss → responde al instante (antes el request enviaba TODOS los
// correos síncronos y el frontend cortaba a los 15s con el lote a medias de
// reportar). Si pg-boss no está disponible, procesa inline (fallback síncrono).
async function distributeToClients({ tenantId, partnerIds, manualEmails, message, subject, sentBy, ipAddress, userAgent }) {
  // 1) Documentos: al menos uno requerido.
  const docs = await getFiscalDocs({ tenantId })
  if (!docs.csf && !docs.opinion) {
    throw createError(400, 'Sube al menos un documento fiscal (CSF u Opinión 32-D) antes de enviar.')
  }

  // 2) Destinatarios: clientes del catálogo + correos manuales (campo tipo Gmail).
  const { clients } = await buildRecipients({ tenantId, partnerIds })
  const manual = normalizeManualEmails(manualEmails)
  if (clients.length === 0 && manual.length === 0) {
    throw createError(400, 'No hay destinatarios: selecciona clientes con correo o escribe al menos un correo manual válido.')
  }
  const clientRecipientCount = clients.reduce((n, c) => n + c.emails.length, 0)
  const recipientCount = clientRecipientCount + manual.length

  // 3) Razón social del emisor para el asunto por default (ver resolveIssuerName:
  //    razón social fiscal → legacy → nombre comercial).
  const tenantName = await resolveIssuerName(tenantId)
  const finalSubject = (subject || '').trim() || `Documentos fiscales — ${tenantName}`

  // 4) Crear el batch de envío (bitácora) en 'queued'.
  const { rows: sendRows } = await query(
    `INSERT INTO fiscal_doc_sends
       (tenant_id, csf_filename, opinion_filename, included_csf, included_opinion,
        subject, message, client_count, recipient_count, status, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10)
     RETURNING id`,
    [tenantId,
     docs.csf?.filename || null, docs.opinion?.filename || null,
     !!docs.csf, !!docs.opinion,
     finalSubject, (message || '').trim() || null,
     clients.length, recipientCount, sentBy || null]
  )
  const sendId = sendRows[0].id

  // 5) Pre-insertar los destinatarios ('queued') = lista de trabajo del worker.
  const pIds = [], pNames = [], emails = []
  for (const client of clients) for (const email of client.emails) {
    pIds.push(client.id); pNames.push(client.name); emails.push(email)
  }
  for (const email of manual) {
    pIds.push(null); pNames.push('(Correo manual)'); emails.push(email)
  }
  await query(
    `INSERT INTO fiscal_doc_send_recipients
       (send_id, tenant_id, partner_id, partner_name, email, status)
     SELECT $1, $2, t.pid, t.pname, t.email, 'queued'
       FROM unnest($3::uuid[], $4::text[], $5::text[]) AS t(pid, pname, email)`,
    [sendId, tenantId, pIds, pNames, emails]
  )

  // 6) Encolar el fan-out (reanudable ante crash). Sin pg-boss → inline.
  const jobId = await tryEnqueueDispatch({ sendId, tenantId })
  const base = { sendId, clientCount: clients.length, manualCount: manual.length, recipientCount }

  if (jobId) {
    return { ...base, status: 'queued', queued: true, failedCount: 0 }
  }
  const final = await processSend({ sendId, tenantId, ipAddress, userAgent })
  return { ...base, queued: false, status: final.status, failedCount: final.failedCount }
}

// ─── Worker: procesar (o reanudar) el fan-out de un envío ────────────────────
// Idempotente: solo toca destinatarios en 'queued'. Un correo por cliente (a
// todos sus contactos) y uno por correo manual. Los docs se re-leen de storage
// (son attachments permanentes del tenant, no buffers del request).
async function processSend({ sendId, tenantId, ipAddress = null, userAgent = null }) {
  const { rows: sr } = await query(
    `SELECT id, subject, message, included_csf, included_opinion,
            client_count, recipient_count, sent_by
       FROM fiscal_doc_sends WHERE id = $1 AND tenant_id = $2`,
    [sendId, tenantId]
  )
  const send = sr[0]
  if (!send) return { status: 'completed', sentCount: 0, failedCount: 0 }

  const { rows: pending } = await query(
    `SELECT id, partner_id, partner_name, email
       FROM fiscal_doc_send_recipients
      WHERE send_id = $1 AND tenant_id = $2 AND status = 'queued'
      ORDER BY partner_name, email`,
    [sendId, tenantId]
  )

  if (pending.length > 0) {
    // Grupos de envío: un correo por cliente; los manuales van individuales.
    const groups = new Map()
    for (const r of pending) {
      const key = r.partner_id ? `p:${r.partner_id}` : `m:${r.email}`
      let g = groups.get(key)
      if (!g) {
        g = { clientName: r.partner_id ? r.partner_name : null, manual: !r.partner_id, emails: [], rowIds: [] }
        groups.set(key, g)
      }
      g.emails.push(r.email)
      g.rowIds.push(r.id)
    }

    // Adjuntos: los docs que el batch marcó como incluidos, releídos de storage.
    const docs = await getFiscalDocs({ tenantId })
    const attachments = []
    const docLabels = []
    for (const [included, doc, label] of [
      [send.included_csf, docs.csf, 'Constancia de Situación Fiscal (CSF)'],
      [send.included_opinion, docs.opinion, 'Opinión de Cumplimiento (art. 32-D)'],
    ]) {
      if (!included || !doc) continue
      try {
        const info = await attachmentService.getAttachmentInfo({ tenantId, attachmentId: doc.id })
        const buffer = info && await storage.fetchBuffer(info.storage_path)
        if (!buffer) continue
        attachments.push({ filename: info.filename, content: buffer, contentType: 'application/pdf' })
        docLabels.push(label)
      } catch (_) { /* si un doc no se puede leer, se evalúa abajo */ }
    }

    if (attachments.length === 0) {
      // Sin documentos legibles no hay nada que mandar: todo el lote falla claro.
      await query(
        `UPDATE fiscal_doc_send_recipients
            SET status = 'failed', error = 'No se pudieron leer los documentos fiscales del almacenamiento.'
          WHERE send_id = $1 AND status = 'queued'`,
        [sendId]
      )
    } else {
      const tenantName = await resolveIssuerName(tenantId)
      const { brandColor, logoCid, logoAttachment } = await getTenantEmailBranding(tenantId)
      if (logoAttachment) attachments.push(logoAttachment)

      let i = 0
      for (const g of groups.values()) {
        const html = fiscalDocsEmail({
          tenantName, clientName: g.clientName, userMessage: send.message,
          docLabels, brandColor, logoCid,
        })
        try {
          await sendEmail({
            to: g.manual ? g.emails[0] : g.emails,
            subject: send.subject, html, attachments,
          })
          await query(
            `UPDATE fiscal_doc_send_recipients SET status = 'sent', error = NULL
              WHERE id = ANY($1::uuid[])`, [g.rowIds])
        } catch (err) {
          await query(
            `UPDATE fiscal_doc_send_recipients SET status = 'failed', error = $2
              WHERE id = ANY($1::uuid[])`, [g.rowIds, err?.message || 'Error al enviar'])
        }
        if (++i < groups.size) await sleep(SEND_STAGGER_MS)
      }
    }
  }

  // Estado final desde la bitácora de destinatarios. Si aún quedan 'queued'
  // (crash a medias), el batch se queda 'queued' y el retry de pg-boss reanuda.
  const { rows: cnt } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'sent')   AS sent,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued
       FROM fiscal_doc_send_recipients WHERE send_id = $1`,
    [sendId]
  )
  const sent = Number(cnt[0].sent), failed = Number(cnt[0].failed), queued = Number(cnt[0].queued)
  const status = queued > 0 ? 'queued' : (failed > 0 ? 'partial' : 'completed')
  await query(`UPDATE fiscal_doc_sends SET status = $1 WHERE id = $2`, [status, sendId])

  if (queued === 0) {
    try {
      await audit({
        tenantId, userId: send.sent_by,
        action: 'fiscal_docs.distributed', resource: 'fiscal_doc_sends', resourceId: sendId,
        payload: { clientCount: send.client_count, recipientCount: send.recipient_count, sent, failed },
        ipAddress, userAgent,
      })
    } catch (_) { /* audit no debe romper el envío */ }
  }

  return { status, sentCount: sent, failedCount: failed }
}

// Registra el worker pg-boss. Se llama en el arranque (crons.js) antes de
// startBoss(). En tests no se invoca (pg-boss desactivado).
function registerDispatchWorker() {
  const { registerWorker } = require('../../utils/pgboss')
  registerWorker(DISPATCH_QUEUE, async (data) => {
    if (!data || !data.sendId || !data.tenantId) return
    await processSend({ sendId: data.sendId, tenantId: data.tenantId })
  })
}

// ─── Historial de envíos ─────────────────────────────────────────────────────
async function listSends({ tenantId, limit = 50 }) {
  const { rows } = await query(
    `SELECT s.id, s.subject, s.included_csf, s.included_opinion,
            s.csf_filename, s.opinion_filename,
            s.client_count, s.recipient_count, s.status, s.created_at,
            u.full_name AS sent_by_name,
            COUNT(r.id) FILTER (WHERE r.status = 'sent')   AS sent_count,
            COUNT(r.id) FILTER (WHERE r.status = 'failed') AS failed_count
       FROM fiscal_doc_sends s
       LEFT JOIN users u ON u.id = s.sent_by
       LEFT JOIN fiscal_doc_send_recipients r ON r.send_id = s.id
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
       FROM fiscal_doc_sends s
       LEFT JOIN users u ON u.id = s.sent_by
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [sendId, tenantId]
  )
  if (!sr[0]) return null
  const { rows: recipients } = await query(
    `SELECT id, partner_id, partner_name, email, status, error, created_at
       FROM fiscal_doc_send_recipients
      WHERE send_id = $1 AND tenant_id = $2
      ORDER BY partner_name, email`,
    [sendId, tenantId]
  )
  return { ...sr[0], recipients }
}

module.exports = {
  uploadFiscalDoc,
  getFiscalDocs,
  getFiscalDocForServe,
  deleteFiscalDoc,
  previewRecipients,
  distributeToClients,
  processSend,
  registerDispatchWorker,
  listSends,
  getSend,
}
