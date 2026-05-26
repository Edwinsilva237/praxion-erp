import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { platformAdminApi } from '@/api/platformAdmin'
import { validatePassword, MIN_LENGTH } from '@/utils/passwordPolicy'

const PLANS = [
  { value: 'free',       label: 'Gratis (trial 14 días)' },
  { value: 'starter',    label: 'Starter' },
  { value: 'pro',        label: 'Pro' },
  { value: 'enterprise', label: 'Empresa' },
  { value: 'owner',      label: 'Owner (interno, sin cobro)' },
]

export default function TenantNew() {
  const [form, setForm] = useState({
    slug: '',
    name: '',
    plan: 'free',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
    adminPhone: '',           // opcional, solo para wa.me — no se envía al backend
    sendInitialPassword: true,
  })
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  const mutation = useMutation({
    mutationFn: () => platformAdminApi.createTenant({
      slug:          form.slug,
      name:          form.name,
      plan:          form.plan,
      adminName:     form.adminName,
      adminEmail:    form.adminEmail,
      adminPassword: form.adminPassword,
      sendInitialPassword: form.sendInitialPassword,
    }),
    onSuccess: (data) => { setSuccess({ ...data, adminPhone: form.adminPhone }) },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error creando organización'),
  })

  function update(field, value) { setForm(f => ({ ...f, [field]: value })) }

  function submit(e) {
    e.preventDefault()
    setError(null)
    if (!form.slug || !form.name || !form.adminEmail || !form.adminName) {
      setError('Todos los campos marcados con * son requeridos.')
      return
    }
    const pwCheck = validatePassword(form.adminPassword)
    if (!pwCheck.valid) {
      setError(pwCheck.reason)
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(form.slug)) {
      setError('Slug inválido. Solo minúsculas, números y guiones; 3-63 caracteres; no inicia/termina en guion.')
      return
    }
    mutation.mutate()
  }

  // Pantalla de éxito tras crear — muestra credenciales para compartir.
  if (success) {
    return <SuccessScreen data={success} />
  }

  return (
    <div className="page-enter max-w-2xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <Link to="/superadmin" className="text-xs text-ink-muted hover:text-ink-primary">← Volver a organizaciones</Link>
        <h1 className="text-xl font-semibold text-ink-primary mt-2">Nueva organización</h1>
        <p className="text-sm text-ink-muted mt-1">
          Provisiona un cliente nuevo de Praxion con su primer usuario administrador.
          El sistema crea automáticamente una suscripción de prueba.
        </p>
      </div>

      {error && <div className="alert-error">{error}</div>}

      <form onSubmit={submit} className="card p-5 flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="text-xs uppercase tracking-wide text-ink-muted mb-1">Organización</legend>

          <div>
            <label className="label">Nombre legal <span className="text-status-danger">*</span></label>
            <input className="input" value={form.name}
              onChange={e => update('name', e.target.value)}
              placeholder="ACME Industrial S.A. de C.V." />
          </div>

          <div>
            <label className="label">Slug (subdominio) <span className="text-status-danger">*</span></label>
            <input className="input font-mono" value={form.slug}
              onChange={e => update('slug', e.target.value.toLowerCase())}
              placeholder="acme" />
            <p className="text-[11px] text-ink-muted mt-1">
              El cliente entrará por <span className="font-mono">{form.slug || 'acme'}.praxionops.com</span>.
              Solo minúsculas, números y guiones.
            </p>
          </div>

          <div>
            <label className="label">Plan inicial</label>
            <select className="input" value={form.plan}
              onChange={e => update('plan', e.target.value)}>
              {PLANS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3 pt-2 border-t border-line-subtle">
          <legend className="text-xs uppercase tracking-wide text-ink-muted mb-1">Usuario administrador</legend>

          <div>
            <label className="label">Nombre completo <span className="text-status-danger">*</span></label>
            <input className="input" value={form.adminName}
              onChange={e => update('adminName', e.target.value)}
              placeholder="Juan Pérez" />
          </div>

          <div>
            <label className="label">Email <span className="text-status-danger">*</span></label>
            <input type="email" className="input" value={form.adminEmail}
              onChange={e => update('adminEmail', e.target.value.toLowerCase())}
              placeholder="admin@acme.com" />
          </div>

          <div>
            <label className="label">Contraseña inicial <span className="text-status-danger">*</span></label>
            <input type="text" className="input font-mono" value={form.adminPassword}
              onChange={e => update('adminPassword', e.target.value)}
              placeholder={`mínimo ${MIN_LENGTH} caracteres`} />
            {form.adminPassword.length > 0 && (() => {
              const c = validatePassword(form.adminPassword)
              return !c.valid
                ? <p className="text-[11px] text-status-warning mt-1">{c.reason}</p>
                : <p className="text-[11px] text-status-success mt-1">✓ Contraseña válida</p>
            })()}
            <p className="text-[11px] text-ink-muted mt-1">
              Tip: el cliente podrá cambiarla al primer login desde "Mi perfil".
            </p>
          </div>

          <div>
            <label className="label">Teléfono WhatsApp <span className="text-ink-muted font-normal">(opcional)</span></label>
            <input type="tel" className="input" value={form.adminPhone}
              onChange={e => update('adminPhone', e.target.value.replace(/[^\d+]/g, ''))}
              placeholder="+52 55 1234 5678" />
            <p className="text-[11px] text-ink-muted mt-1">
              Con este número podrás compartirle las credenciales por WhatsApp con un clic, después de crear la cuenta.
            </p>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2 pt-2 border-t border-line-subtle">
          <legend className="text-xs uppercase tracking-wide text-ink-muted mb-1">Notificación</legend>

          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" className="mt-0.5"
              checked={form.sendInitialPassword}
              onChange={e => update('sendInitialPassword', e.target.checked)} />
            <span className="text-sm text-ink-secondary">
              Enviar email automático al cliente con sus credenciales (email + contraseña + link de acceso).
            </span>
          </label>
        </fieldset>

        <div className="flex justify-end gap-2 pt-2 border-t border-line-subtle">
          <Link to="/superadmin" className="btn-ghost">Cancelar</Link>
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creando...' : 'Crear organización'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ─── Pantalla de éxito con caja de credenciales para compartir ───────────────
function SuccessScreen({ data }) {
  const nav = useNavigate()
  const [copied, setCopied] = useState(false)
  const { tenant, credentials, emailSent, adminPhone } = data

  const message =
`¡Bienvenido a Praxion!

Tu cuenta de ${tenant.name} ya está lista. Aquí tienes tus datos de acceso:

🌐 Sistema: ${credentials.loginUrl}
📧 Email: ${credentials.email}
🔑 Contraseña: ${credentials.tempPassword}

Por seguridad te recomendamos cambiarla al entrar por primera vez (Mi perfil → Cambiar contraseña).`

  function copyAll() {
    navigator.clipboard.writeText(message).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Construye el link wa.me. Si hay teléfono, va a ese número; si no, abre
  // sin destinatario y el usuario lo elige. El mensaje va URL-encoded.
  const waPhone = (adminPhone || '').replace(/[^\d]/g, '')
  const waUrl = waPhone
    ? `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`

  return (
    <div className="page-enter max-w-2xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-status-success/15 text-status-success flex items-center justify-center">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Organización creada</h1>
          <p className="text-sm text-ink-muted">
            <span className="font-medium text-ink-secondary">{tenant.name}</span> ya está lista para usarse.
          </p>
        </div>
      </div>

      {emailSent && (
        <div className="alert-info text-xs">
          📨 Enviamos un correo a <strong>{credentials.email}</strong> con sus datos de acceso.
        </div>
      )}

      <section className="card p-5 flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-primary">Credenciales de acceso</h2>
          <p className="text-xs text-ink-muted mt-1">
            Esta es la <strong>única vez</strong> que verás la contraseña en pantalla.
            Cópiala o compártela ahora — no se podrá recuperar después (solo restablecer).
          </p>
        </div>

        <div className="bg-surface-elevated/50 border border-line-subtle rounded-lg p-4 flex flex-col gap-2 text-sm font-mono">
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Sistema</span>
            <span className="text-ink-primary break-all">{credentials.loginUrl}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Email</span>
            <span className="text-ink-primary">{credentials.email}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Contraseña</span>
            <span className="text-ink-primary">{credentials.tempPassword}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={copyAll} className="btn-ghost flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {copied ? '¡Copiado!' : 'Copiar todo'}
          </button>

          <a href={waUrl} target="_blank" rel="noopener noreferrer"
            className="btn-ghost flex items-center gap-2 text-status-success">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            Enviar por WhatsApp
          </a>

          <button onClick={() => nav(`/superadmin/tenants/${tenant.id}`)} className="btn-primary ml-auto">
            Ver detalle de la organización →
          </button>
        </div>

        {!waPhone && (
          <p className="text-[11px] text-ink-muted">
            El botón de WhatsApp abrirá la app sin destinatario — tendrás que elegir el contacto.
            Para ahorrarte ese paso, captura el teléfono al crear la cuenta.
          </p>
        )}
      </section>

      <p className="text-xs text-ink-muted text-center">
        💡 En el futuro podemos integrar el envío automático vía WhatsApp Business API
        (sin abrir la app del navegador). Esa integración requiere alta y verificación con Meta.
      </p>
    </div>
  )
}
