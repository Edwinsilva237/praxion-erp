'use strict'

// Jobs de notificación de mensajes del sistema.
// Los registra crons.js con pg-boss para correr cada hora.

const { query, withBypass } = require('../../db')
const { enqueueEmail } = require('../../queues/emailQueue')
const config = require('../../config')
const logger = require('../../config/logger')
const svc = require('./systemMessagesService')

/**
 * 1) Para cada mensaje con notify_email=TRUE que ya está vigente y aún no se
 *    notificó: mandar correo a TODOS los tenants (cada uno a su
 *    notification_email — fallback al email del primer super_admin).
 */
async function sendPendingNotifications() {
  const pending = await svc.findPendingNotifications()
  for (const msg of pending) {
    try {
      const recipients = await getAllTenantEmails()
      if (recipients.length === 0) {
        logger.warn(`[system-messages] mensaje ${msg.id}: no hay destinatarios`)
        await svc.markNotified(msg.id) // marcamos para no reintentar infinito
        continue
      }
      const html = buildInitialEmailHTML(msg)
      const subject = msg.kind === 'maintenance'
        ? `Mantenimiento programado: ${msg.title}`
        : msg.title
      // Un correo por destinatario para evitar exponer la lista en BCC y
      // que cada cliente pueda responder al hilo. La cola maneja reintentos.
      for (const to of recipients) {
        await enqueueEmail({ to, subject, html })
      }
      await svc.markNotified(msg.id)
      logger.info(`[system-messages] notificación inicial enviada a ${recipients.length} tenant(s) — msg ${msg.id}`)
    } catch (err) {
      logger.error(`[system-messages] error notificando msg ${msg.id}`, { error: err.message })
    }
  }
}

/**
 * 2) Para cada mantenimiento que ocurre en 23-26 horas y no se le ha mandado
 *    recordatorio: enviar a tenants + recordatorio al platform admin.
 */
async function sendPendingReminders() {
  const pending = await svc.findPendingReminders()
  for (const msg of pending) {
    try {
      const tenants = await getAllTenantEmails()
      const html = buildReminderEmailHTML(msg)
      const subject = `Recordatorio: mantenimiento mañana — ${msg.title}`
      for (const to of tenants) {
        await enqueueEmail({ to, subject, html })
      }
      await svc.markReminderSent(msg.id)

      // Recordatorio al platform admin para que recuerde ejecutarlo.
      const admins = await getPlatformAdminEmails()
      if (admins.length > 0) {
        const adminHtml = buildAdminReminderEmailHTML(msg)
        for (const to of admins) {
          await enqueueEmail({
            to,
            subject: `[Praxion] Mantenimiento mañana: ${msg.title}`,
            html: adminHtml,
          })
        }
        await svc.markAdminReminded(msg.id)
      }

      logger.info(`[system-messages] recordatorio enviado para msg ${msg.id} (${tenants.length} tenants + ${admins.length} admins)`)
    } catch (err) {
      logger.error(`[system-messages] error en recordatorio msg ${msg.id}`, { error: err.message })
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function getAllTenantEmails() {
  // Estrategia: si el tenant tiene notification_email, ese.
  // Si no, el email del usuario más antiguo activo del tenant (super_admin
  // típicamente). Excluimos tenants suspendidos manualmente.
  const { rows } = await withBypass(() => query(
    `WITH primary_user AS (
       SELECT DISTINCT ON (u.tenant_id) u.tenant_id, u.email
         FROM users u
        WHERE u.is_active = TRUE
        ORDER BY u.tenant_id, u.created_at ASC
     )
     SELECT COALESCE(t.notification_email, pu.email) AS email
       FROM tenants t
       LEFT JOIN primary_user pu ON pu.tenant_id = t.id
      WHERE t.is_active = TRUE
        AND COALESCE(t.notification_email, pu.email) IS NOT NULL`
  ))
  return [...new Set(rows.map(r => r.email).filter(Boolean))]
}

async function getPlatformAdminEmails() {
  const { rows } = await withBypass(() => query(
    `SELECT DISTINCT u.email
       FROM users u
      WHERE u.is_platform_admin = TRUE AND u.is_active = TRUE`
  ))
  return rows.map(r => r.email)
}

function fmtDateTime(date) {
  if (!date) return ''
  return new Date(date).toLocaleString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(minutes) {
  if (!minutes) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} minutos`
  if (m === 0) return `${h} hora${h > 1 ? 's' : ''}`
  return `${h} h ${m} min`
}

const SEVERITY_COLOR = {
  info:     '#3B82F6',
  success:  '#10B981',
  warning:  '#F59E0B',
  critical: '#EF4444',
}

function buildInitialEmailHTML(msg) {
  const color = SEVERITY_COLOR[msg.severity] || SEVERITY_COLOR.info
  const isMaint = msg.kind === 'maintenance'
  const maintBlock = isMaint
    ? `<div style="background:#f9fafb;border-left:4px solid ${color};padding:14px 16px;margin:18px 0;border-radius:6px;">
         <p style="margin:0 0 6px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Mantenimiento programado</p>
         <p style="margin:0 0 2px;font-size:15px;color:#111827;"><strong>Cuándo:</strong> ${escapeHTML(fmtDateTime(msg.maintenance_at))}</p>
         <p style="margin:0;font-size:15px;color:#111827;"><strong>Duración estimada:</strong> ${escapeHTML(fmtDuration(msg.duration_minutes))}</p>
       </div>`
    : ''

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="background:${color};padding:24px 32px;color:#fff;">
      <h1 style="margin:0;font-size:18px;font-weight:600;">${escapeHTML(msg.title)}</h1>
    </div>
    <div style="padding:28px 32px;color:#374151;font-size:15px;line-height:1.65;">
      ${maintBlock}
      <div style="white-space:pre-wrap;">${escapeHTML(msg.message)}</div>
      <p style="font-size:13px;color:#6b7280;margin-top:24px;">
        Recibiste este mensaje porque eres administrador de una organización en Praxion.
      </p>
    </div>
  </div>
</body></html>`
}

function buildReminderEmailHTML(msg) {
  return buildInitialEmailHTML({
    ...msg,
    title: `⏰ Recordatorio: ${msg.title} — mañana`,
  })
}

function buildAdminReminderEmailHTML(msg) {
  const color = SEVERITY_COLOR[msg.severity] || SEVERITY_COLOR.info
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="background:${color};padding:24px 32px;color:#fff;">
      <h1 style="margin:0;font-size:18px;font-weight:600;">🛠 Es hora de ejecutar el mantenimiento</h1>
    </div>
    <div style="padding:28px 32px;color:#374151;font-size:15px;line-height:1.65;">
      <p>Recordatorio para ti como platform admin de Praxion:</p>
      <div style="background:#f9fafb;border-left:4px solid ${color};padding:14px 16px;margin:18px 0;border-radius:6px;">
        <p style="margin:0 0 4px;font-size:16px;color:#111827;"><strong>${escapeHTML(msg.title)}</strong></p>
        <p style="margin:0;font-size:14px;color:#6b7280;"><strong>Programado:</strong> ${escapeHTML(fmtDateTime(msg.maintenance_at))} (en ~24 h)</p>
        <p style="margin:4px 0 0;font-size:14px;color:#6b7280;"><strong>Duración:</strong> ${escapeHTML(fmtDuration(msg.duration_minutes))}</p>
      </div>
      <p>Los tenants ya recibieron su recordatorio. Revisa el checklist en
      <code>project_pendientes_proxima_sesion</code> o el plan de mantenimiento de la sesión.</p>
      <p style="font-size:13px;color:#6b7280;">Mensaje:</p>
      <div style="white-space:pre-wrap;font-size:13px;color:#6b7280;background:#f9fafb;padding:12px;border-radius:6px;">${escapeHTML(msg.message)}</div>
    </div>
  </div>
</body></html>`
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

module.exports = { sendPendingNotifications, sendPendingReminders }
