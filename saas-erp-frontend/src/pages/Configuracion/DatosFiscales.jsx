import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fiscalProfilesApi } from '@/api/fiscalProfiles'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const TAX_REGIMES = [
  ['601', '601 — General de Ley Personas Morales'],
  ['603', '603 — Personas Morales con Fines no Lucrativos'],
  ['605', '605 — Sueldos y Salarios'],
  ['606', '606 — Arrendamiento'],
  ['607', '607 — Régimen de Enajenación o Adquisición de Bienes'],
  ['608', '608 — Demás ingresos'],
  ['612', '612 — Personas Físicas con Actividades Empresariales y Profesionales'],
  ['614', '614 — Ingresos por intereses'],
  ['616', '616 — Sin obligaciones fiscales'],
  ['620', '620 — Sociedades Cooperativas de Producción'],
  ['621', '621 — Incorporación Fiscal'],
  ['622', '622 — Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras'],
  ['625', '625 — RIF / Plataformas Tecnológicas'],
  ['626', '626 — Régimen Simplificado de Confianza (RESICO)'],
]

// ── Modal: subir CSD ────────────────────────────────────────────────────────
function CertModal({ profile, onClose }) {
  const qc = useQueryClient()
  const [cerFile, setCer] = useState(null)
  const [keyFile, setKey] = useState(null)
  const [password, setPwd] = useState('')
  const [error, setError] = useState(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (!cerFile) throw new Error('Selecciona el archivo .cer')
      if (!keyFile) throw new Error('Selecciona el archivo .key')
      if (!password) throw new Error('Captura el password del CSD')
      return fiscalProfilesApi.uploadCertificate(profile.id, cerFile, keyFile, password)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fiscal-profile'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al subir CSD'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">🔐 Subir CSD del SAT</h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Para el RFC <span className="font-mono">{profile.rfc}</span>
          </p>
          <p className="text-[11px] text-status-warning mt-2 bg-status-warning/10 border border-status-warning/40 rounded-lg px-2 py-1.5">
            ⚠ Los archivos se suben directo al servicio de timbrado. <strong>No los guardamos</strong> ni vemos el password.
          </p>
        </div>

        <div>
          <label className="label">Certificado (.cer) <span className="text-status-danger">*</span></label>
          <input type="file" accept=".cer"
            onChange={e => setCer(e.target.files?.[0] || null)}
            className="block w-full text-xs file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-brand-500/10 file:text-brand-300 hover:file:bg-brand-500/15" />
          {cerFile && <p className="text-[11px] text-status-success mt-1">✓ {cerFile.name}</p>}
        </div>

        <div>
          <label className="label">Llave privada (.key) <span className="text-status-danger">*</span></label>
          <input type="file" accept=".key"
            onChange={e => setKey(e.target.files?.[0] || null)}
            className="block w-full text-xs file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-brand-500/10 file:text-brand-300 hover:file:bg-brand-500/15" />
          {keyFile && <p className="text-[11px] text-status-success mt-1">✓ {keyFile.name}</p>}
        </div>

        <div>
          <label className="label">Password del CSD <span className="text-status-danger">*</span></label>
          <input type="password" className="input"
            value={password} onChange={e => setPwd(e.target.value)}
            placeholder="••••••••" autoComplete="off" />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending || !cerFile || !keyFile || !password}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Subir CSD'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Form de datos (compartido entre wizard y edición) ──────────────────────
function FormDatos({ initial, onSave, onCancel, saving, error, isFirstSetup }) {
  const [rfc, setRfc]             = useState(initial?.rfc || '')
  const [taxName, setTaxName]     = useState(initial?.tax_name || '')
  const [taxRegime, setTaxRegime] = useState(initial?.tax_regime || '601')
  const [zipCode, setZipCode]     = useState(initial?.zip_code || '')
  const [createInFacturapi, setCreate] = useState(isFirstSetup)
  const [csfLoading, setCsfLoading] = useState(false)
  const [csfMsg, setCsfMsg] = useState(null)
  const csfRef = useRef(null)

  async function handleCsfFile(file) {
    if (!file) return
    setCsfLoading(true)
    setCsfMsg(null)
    try {
      const result = await fiscalProfilesApi.parseCsf(file)
      const x = result.extracted || {}
      // Aplicar lo que el parser haya podido extraer
      if (x.rfc)        setRfc(x.rfc)
      if (x.name)       setTaxName(x.name)
      if (x.zipCode)    setZipCode(x.zipCode)
      // El select de régimen espera el CÓDIGO SAT (601, 612, ...), no el
      // texto descriptivo. Preferimos `taxRegimeCode` que ya viene resuelto
      // del backend; si no llega y `taxRegime` es un código válido (3 dígitos),
      // lo usamos. Si llega solo el texto, NO lo asignamos para no romper el select.
      const validCode = (x.taxRegimeCode && TAX_REGIMES.some(([c]) => c === x.taxRegimeCode))
        ? x.taxRegimeCode
        : (/^\d{3}$/.test(x.taxRegime) && TAX_REGIMES.some(([c]) => c === x.taxRegime))
          ? x.taxRegime
          : null
      if (validCode) setTaxRegime(validCode)
      const detected = [
        x.rfc       && 'RFC',
        x.name      && 'razón social',
        validCode   && 'régimen',
        x.zipCode   && 'CP',
      ].filter(Boolean)
      setCsfMsg({
        type: result.warning ? 'warning' : 'success',
        text: detected.length
          ? `✓ Detectado: ${detected.join(', ')}${result.warning ? ` · ⚠ ${result.warning}` : ''}`
          : '⚠ No se pudo extraer información del PDF. Revisa que sea una CSF válida o captura los datos manualmente.',
      })
    } catch (e) {
      setCsfMsg({
        type: 'error',
        text: e.response?.data?.error || e.message || 'Error al procesar la CSF',
      })
    } finally {
      setCsfLoading(false)
      if (csfRef.current) csfRef.current.value = ''
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSave({
      rfc: rfc.trim().toUpperCase(),
      taxName: taxName.trim(),
      taxRegime: taxRegime.trim(),
      zipCode: zipCode.trim(),
      // serie ya no se captura aquí: vive en Configuración → Series y folios.
      // El backend auto-crea una serie default 'A' al provisionar el perfil.
      createInFacturapi: isFirstSetup ? createInFacturapi : undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Botón cargar CSF — atajo para llenar el form automáticamente */}
      <div className="bg-brand-500/10 border border-brand-100 rounded-xl p-3 flex items-start gap-3">
        <span className="text-2xl shrink-0">📄</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-brand-300">
            ¿Tienes el PDF de tu Constancia de Situación Fiscal?
          </p>
          <p className="text-[11px] text-brand-300/80 mt-0.5">
            Súbelo y prellenamos los campos automáticamente (RFC, razón social, régimen, CP).
          </p>
          {csfMsg && (
            <p className={clsx('text-[11px] mt-1.5',
              csfMsg.type === 'success' ? 'text-status-success' :
              csfMsg.type === 'warning' ? 'text-status-warning' : 'text-status-danger')}>
              {csfMsg.text}
            </p>
          )}
        </div>
        <button type="button"
          onClick={() => csfRef.current?.click()}
          disabled={csfLoading}
          className="btn-secondary btn-sm shrink-0">
          {csfLoading ? <Spinner size="sm" /> : '📤 Subir CSF'}
        </button>
        <input ref={csfRef} type="file" accept=".pdf,application/pdf"
          onChange={(e) => handleCsfFile(e.target.files?.[0])}
          className="hidden" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">RFC <span className="text-status-danger">*</span></label>
          <input className="input font-mono uppercase" value={rfc}
            onChange={e => setRfc(e.target.value.toUpperCase())}
            maxLength={13} placeholder="XAXX010101000" required />
        </div>
        <div>
          <label className="label">Código postal <span className="text-status-danger">*</span></label>
          <input className="input font-mono" value={zipCode}
            onChange={e => setZipCode(e.target.value)}
            maxLength={5} pattern="[0-9]{5}" placeholder="01000" required />
          <p className="text-[10px] text-ink-muted mt-0.5">Lugar de expedición del CFDI.</p>
        </div>
      </div>

      <div>
        <label className="label">Razón social <span className="text-status-danger">*</span></label>
        <input className="input" value={taxName}
          onChange={e => setTaxName(e.target.value)}
          placeholder="Como aparece en tu Constancia de Situación Fiscal" required />
      </div>

      <div>
        <label className="label">Régimen fiscal <span className="text-status-danger">*</span></label>
        <select className="select" value={taxRegime}
          onChange={e => setTaxRegime(e.target.value)} required>
          {TAX_REGIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      {isFirstSetup && (
        <label className="flex items-start gap-2 text-sm cursor-pointer bg-status-info/10 border border-status-info/40 rounded-lg p-3">
          <input type="checkbox" className="mt-0.5 w-4 h-4 accent-brand-600"
            checked={createInFacturapi}
            onChange={e => setCreate(e.target.checked)} />
          <div>
            <p className="font-semibold text-status-info">Crear cuenta de timbrado automáticamente</p>
            <p className="text-[11px] text-status-info/80 mt-0.5">
              Te configuramos automáticamente la integración con el servicio de timbrado.
              Después podrás subir tu CSD desde esta pantalla.
            </p>
          </div>
        </label>
      )}

      {error && <p className="field-error">{error}</p>}

      <div className="flex gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-secondary flex-1">Cancelar</button>
        )}
        <button type="submit" disabled={saving}
          className="btn-primary flex-1">
          {saving ? <Spinner size="sm" /> : (isFirstSetup ? 'Guardar y continuar' : 'Guardar cambios')}
        </button>
      </div>
    </form>
  )
}

// ── Página principal ───────────────────────────────────────────────────────
export default function DatosFiscales() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [showCert, setShowCert] = useState(false)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)

  // listProfiles devuelve 0 o 1 (UNIQUE en BD)
  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['fiscal-profile'],
    queryFn:  () => fiscalProfilesApi.list(),
  })
  const profile = profiles[0] || null

  const saveMutation = useMutation({
    mutationFn: (body) => profile
      ? fiscalProfilesApi.update(profile.id, body)
      : fiscalProfilesApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fiscal-profile'] })
      setEditing(false)
      setMsg(profile ? 'Datos fiscales actualizados.' : 'Datos fiscales configurados. Ahora sube tu CSD.')
      setError(null)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  // ── Wizard inicial (no hay profile todavía) ────────────────────────────
  if (!isLoading && !profile) {
    return (
      <div className="page-enter max-w-2xl">
        <h1 className="text-xl font-semibold text-ink-primary">Configurar datos fiscales</h1>
        <p className="text-xs text-ink-muted mt-0.5 mb-4">
          Captura los datos del RFC desde el cual emitirás tus CFDIs.
        </p>

        <div className="card p-5">
          <FormDatos
            initial={null}
            isFirstSetup={true}
            saving={saveMutation.isPending}
            error={error}
            onSave={(body) => { setError(null); saveMutation.mutate(body) }}
          />
        </div>

        <p className="text-[11px] text-ink-muted mt-3 text-center">
          Después de guardar podrás subir tu certificado de sello digital (.cer + .key).
        </p>
      </div>
    )
  }

  if (isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }

  // ── Vista normal: card con datos + secciones ──────────────────────────
  return (
    <div className="page-enter flex flex-col gap-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Datos fiscales</h1>
        <p className="text-xs text-ink-muted mt-0.5">
          Información del RFC emisor de tus CFDIs y certificado de sello digital.
        </p>
      </div>

      {msg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-sm text-status-success">{msg}</p>
          <button onClick={() => setMsg(null)} className="text-status-success">✕</button>
        </div>
      )}

      {/* Card principal: datos fiscales */}
      <div className="card p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">🧾 Información fiscal</h2>
            <p className="text-xs text-ink-muted mt-0.5">Como aparece en tu Constancia SAT.</p>
          </div>
          {!editing && (
            <Can do="settings:update">
              <button onClick={() => setEditing(true)} className="btn-ghost btn-sm text-brand-300">
                Editar
              </button>
            </Can>
          )}
        </div>

        {editing ? (
          <FormDatos
            initial={profile}
            isFirstSetup={false}
            saving={saveMutation.isPending}
            error={error}
            onCancel={() => { setEditing(false); setError(null) }}
            onSave={(body) => { setError(null); saveMutation.mutate(body) }}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div>
                <p className="text-[10px] text-ink-muted uppercase tracking-wide">Razón social</p>
                <p className="font-medium text-ink-primary">{profile.tax_name}</p>
              </div>
              <div>
                <p className="text-[10px] text-ink-muted uppercase tracking-wide">RFC</p>
                <p className="font-mono font-medium text-ink-primary">{profile.rfc}</p>
              </div>
              <div>
                <p className="text-[10px] text-ink-muted uppercase tracking-wide">Régimen fiscal</p>
                <p className="font-medium text-ink-primary">{profile.tax_regime}</p>
              </div>
              <div>
                <p className="text-[10px] text-ink-muted uppercase tracking-wide">Código postal</p>
                <p className="font-mono font-medium text-ink-primary">{profile.zip_code}</p>
              </div>
            </div>
            <p className="text-[11px] text-ink-muted mt-3">
              💡 Las series de folios se administran en <span className="text-brand-300">Configuración → Series y folios</span>.
            </p>
          </>
        )}
      </div>

      {/* Card: integración Facturapi (estado interno) */}
      <div className="card p-5">
        <h2 className="text-base font-semibold text-ink-primary mb-3">⚙ Estado del servicio de timbrado</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className={clsx('rounded-lg border p-3',
            profile.facturapi_organization_id
              ? 'border-emerald-200 bg-emerald-50'
              : 'border-status-warning/40 bg-status-warning/10')}>
            <p className="text-[10px] uppercase tracking-wide opacity-70 mb-1">Cuenta de timbrado</p>
            <p className="text-sm font-semibold">
              {profile.facturapi_organization_id
                ? '✓ Configurada'
                : '⚠ Pendiente'}
            </p>
            {profile.facturapi_organization_id && (
              <p className="text-[10px] text-ink-muted font-mono mt-1 truncate">
                {profile.facturapi_organization_id}
              </p>
            )}
          </div>
          <div className={clsx('rounded-lg border p-3',
            profile.facturapi_certificate_status === 'uploaded' ||
            profile.facturapi_certificate_status === 'verified'
              ? 'border-emerald-200 bg-emerald-50'
              : 'border-status-warning/40 bg-status-warning/10')}>
            <p className="text-[10px] uppercase tracking-wide opacity-70 mb-1">CSD (sello digital)</p>
            <p className="text-sm font-semibold">
              🔐 {profile.facturapi_certificate_status === 'uploaded' || profile.facturapi_certificate_status === 'verified'
                ? 'Cargado'
                : 'No cargado'}
            </p>
            {profile.facturapi_certificate_expires_at && (
              <p className="text-[10px] text-ink-muted mt-1">
                Expira: {fmtDate(profile.facturapi_certificate_expires_at)}
              </p>
            )}
          </div>
        </div>

        {profile.facturapi_organization_id && (
          <Can do="settings:update">
            <div className="mt-4 flex gap-2">
              <button onClick={() => setShowCert(true)} className="btn-primary btn-sm">
                {profile.facturapi_certificate_status ? '🔐 Reemplazar CSD' : '🔐 Subir CSD'}
              </button>
            </div>
          </Can>
        )}

        {!profile.facturapi_organization_id && (
          <p className="text-[11px] text-status-warning mt-3">
            ⚠ Aún no se ha configurado la cuenta de timbrado. Contacta a soporte si necesitas ayuda.
          </p>
        )}
      </div>

      {showCert && (
        <CertModal profile={profile} onClose={() => setShowCert(false)} />
      )}
    </div>
  )
}
