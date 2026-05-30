import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tenantsApi } from '@/api/tenants'
import Spinner from '@/components/ui/Spinner'
import Can, { useCan } from '@/components/auth/Can'

const DEFAULT_PRIMARY   = '#5E9F32'
const DEFAULT_SECONDARY = '#3F7324'

export default function IdentidadMarca() {
  const qc = useQueryClient()
  const canEdit = useCan('settings:update')
  const fileInput = useRef(null)

  const [displayName, setDisplayName] = useState('')
  const [primary, setPrimary]         = useState(DEFAULT_PRIMARY)
  const [secondary, setSecondary]     = useState(DEFAULT_SECONDARY)
  const [touched, setTouched]         = useState(false)

  const [preview, setPreview]         = useState(null)
  const [pendingFile, setPendingFile] = useState(null)
  const [msg, setMsg]                 = useState(null)
  const [error, setError]             = useState(null)

  const { data: tenant, isLoading } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
  })

  useEffect(() => {
    if (tenant && !touched) {
      setDisplayName(tenant.display_name || tenant.name || '')
      setPrimary(tenant.brand_color_primary   || DEFAULT_PRIMARY)
      setSecondary(tenant.brand_color_secondary || DEFAULT_SECONDARY)
    }
  }, [tenant, touched])

  const saveSettings = useMutation({
    mutationFn: (payload) => tenantsApi.updateCurrent(payload),
    onSuccess: (data) => {
      setMsg('Identidad de marca actualizada.'); setError(null); setTouched(false)
      qc.setQueryData(['tenant', 'current'], (prev) => ({ ...prev, ...data }))
    },
    onError: (e) => { setError(e.response?.data?.error || e.message); setMsg(null) },
  })

  const uploadLogo = useMutation({
    mutationFn: (file) => tenantsApi.uploadLogo(file),
    onSuccess: () => {
      setMsg('Logo actualizado.'); setError(null)
      setPreview(null); setPendingFile(null)
      qc.invalidateQueries({ queryKey: ['tenant', 'current'] })
    },
    onError: (e) => { setError(e.response?.data?.error || e.message); setMsg(null) },
  })

  const deleteLogo = useMutation({
    mutationFn: () => tenantsApi.deleteLogo(),
    onSuccess: () => {
      setMsg('Logo eliminado. Vuelve a aparecer el isotipo Praxion.'); setError(null)
      qc.invalidateQueries({ queryKey: ['tenant', 'current'] })
    },
    onError: (e) => { setError(e.response?.data?.error || e.message); setMsg(null) },
  })

  const syncFiscal = useMutation({
    mutationFn: () => tenantsApi.syncFiscalBranding(),
    onSuccess: (data) => {
      const parts = []
      if (data.logo?.synced)   parts.push('logo subido')
      if (data.colors?.synced) parts.push('colores aplicados')
      if (parts.length) {
        setMsg(`Sincronizado con Facturapi: ${parts.join(' + ')}. Tus próximas facturas saldrán con esta identidad.`)
      } else {
        const reason = data.logo?.reason || data.colors?.reason
        if (reason === 'sin_organizacion_fiscal') {
          setError('Tu cuenta aún no tiene una organización en Facturapi. Configura primero "Datos fiscales".')
        } else if (reason === 'sin_logo' && data.colors?.reason === 'sin_colores') {
          setError('No hay logo ni colores que sincronizar. Sube un logo o elige colores primero.')
        } else {
          setMsg('Sincronización completada (sin cambios efectivos).')
        }
      }
      setError(null)
    },
    onError: (e) => {
      setError(e.response?.data?.error || e.message || 'No se pudo sincronizar con Facturapi.')
      setMsg(null)
    },
  })

  function pickFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null); setMsg(null)
    if (f.size > 2 * 1024 * 1024) {
      setError('El logo no debe exceder 2 MB.')
      return
    }
    setPendingFile(f)
    setPreview(URL.createObjectURL(f))
  }

  function confirmUpload() {
    if (!pendingFile) return
    uploadLogo.mutate(pendingFile)
  }

  function cancelPreview() {
    setPendingFile(null); setPreview(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  function saveAll() {
    saveSettings.mutate({
      displayName,
      brandColorPrimary:   primary,
      brandColorSecondary: secondary,
    })
  }

  const currentLogo = tenant?.logo_url
  const hasChanges  = touched && (
    displayName !== (tenant?.display_name || tenant?.name || '') ||
    primary     !== (tenant?.brand_color_primary   || DEFAULT_PRIMARY) ||
    secondary   !== (tenant?.brand_color_secondary || DEFAULT_SECONDARY)
  )

  return (
    <div className="page-enter max-w-4xl mx-auto py-6 px-4 flex flex-col gap-6">
      <div>
        <p className="eyebrow">CONFIGURACIÓN</p>
        <h1 className="text-xl font-semibold text-ink-primary mt-1">Identidad de marca</h1>
        <p className="text-sm text-ink-muted mt-1">
          Personaliza el logo, nombre comercial y colores. Al pulsar <strong>Guardar
          cambios</strong> se aplican en el panel y en todos los PDFs del sistema
          (cotización, remisión, factura impresa, recibo, orden de compra). Para el
          CFDI timbrado oficial, además sincroniza con Facturapi.
        </p>
      </div>

      {msg   && <div className="alert-success text-sm">{msg}</div>}
      {error && <div className="alert-error text-sm">{error}</div>}

      {/* ── Logo ───────────────────────────────────────────────────────── */}
      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Logo</h2>
          <p className="text-xs text-ink-muted mt-1">
            Aparece en el menú lateral, el dashboard y en los PDFs del sistema
            (cotización, remisión, factura, recibo, orden de compra). Para el CFDI
            timbrado, sincronízalo con Facturapi. Usa <strong>PNG o JPG</strong> — SVG
            y WebP no se dibujan en los PDFs internos. Hasta 2 MB.
          </p>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-6 items-start">
            <div className="shrink-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-muted mb-2">
                {preview ? 'Vista previa' : 'Logo actual'}
              </p>
              <div className="w-40 h-40 rounded-md border border-line-subtle bg-bg-tertiary flex items-center justify-center overflow-hidden">
                {preview ? (
                  <img src={preview} alt="Vista previa" className="max-w-full max-h-full object-contain" />
                ) : currentLogo ? (
                  <img src={currentLogo} alt="Logo actual" className="max-w-full max-h-full object-contain" />
                ) : (
                  <div className="text-ink-muted text-xs text-center px-2">
                    Sin logo<br/>
                    <span className="text-[10px]">Se muestra Praxion por defecto</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 flex flex-col gap-3 min-w-0">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={pickFile}
              />

              {pendingFile ? (
                <>
                  <div className="text-sm text-ink-secondary">
                    Archivo: <strong className="text-ink-primary">{pendingFile.name}</strong>{' '}
                    ({(pendingFile.size / 1024).toFixed(0)} KB)
                  </div>
                  <Can do="settings:update">
                    <div className="flex gap-2">
                      <button onClick={confirmUpload} disabled={uploadLogo.isPending} className="btn-primary justify-center">
                        {uploadLogo.isPending ? <Spinner size="sm" /> : 'Guardar logo'}
                      </button>
                      <button onClick={cancelPreview} className="btn-secondary">Cancelar</button>
                    </div>
                  </Can>
                </>
              ) : (
                <>
                  <Can do="settings:update">
                    <button onClick={() => fileInput.current?.click()} className="btn-secondary justify-center">
                      {currentLogo ? 'Cambiar logo' : 'Subir logo'}
                    </button>
                  </Can>
                  {currentLogo && (
                    <Can do="settings:update">
                      <button
                        onClick={() => {
                          if (confirm('¿Eliminar el logo? Volverá a mostrarse el isotipo Praxion.')) deleteLogo.mutate()
                        }}
                        disabled={deleteLogo.isPending}
                        className="text-xs text-status-danger hover:underline self-start">
                        Eliminar logo actual
                      </button>
                    </Can>
                  )}
                  <p className="text-xs text-ink-muted">
                    Recomendado: fondo transparente, mínimo 200×200 px.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Nombre comercial + Colores ─────────────────────────────────── */}
      <section className="card flex flex-col gap-5">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Nombre y colores</h2>
          <p className="text-xs text-ink-muted mt-1">
            Define el nombre comercial y los colores corporativos. Tras <strong>Guardar
            cambios</strong> se aplican a todos los PDFs del sistema. El CFDI timbrado
            los toma al sincronizar con Facturapi.
          </p>
        </div>

        <div>
          <label className="label">Nombre comercial</label>
          <input
            type="text" className="input" maxLength={120}
            placeholder="Mi Empresa SA de CV"
            value={displayName}
            disabled={!canEdit}
            onChange={e => { setDisplayName(e.target.value); setTouched(true) }}
          />
          <p className="text-[10px] text-ink-muted mt-1">
            Es visible en el menú lateral. No cambia el nombre legal (eso vive en Datos fiscales).
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ColorPicker
            label="Color primario"
            value={primary}
            disabled={!canEdit}
            onChange={(v) => { setPrimary(v); setTouched(true) }}
            description="Banner superior y encabezados de los PDFs (cotización, remisión, factura, recibo, OC)."
          />
          <ColorPicker
            label="Color secundario"
            value={secondary}
            disabled={!canEdit}
            onChange={(v) => { setSecondary(v); setTouched(true) }}
            description="Líneas y detalles menores del PDF."
          />
        </div>

        {/* Vista previa */}
        <InvoicePreview
          logo={currentLogo}
          name={displayName || tenant?.name}
          primary={primary}
          secondary={secondary}
        />

        <Can do="settings:update" fallback={
          <p className="text-[11px] text-ink-muted italic mt-2">
            Solo lectura — tu rol no incluye permiso para editar la configuración.
          </p>
        }>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={saveAll}
              disabled={!hasChanges || saveSettings.isPending}
              className="btn-primary justify-center">
              {saveSettings.isPending ? <Spinner size="sm" /> : 'Guardar cambios'}
            </button>
            <button
              onClick={() => syncFiscal.mutate()}
              disabled={syncFiscal.isPending}
              className="btn-secondary justify-center"
              title="Sube tu logo y colores a Facturapi. Las próximas facturas saldrán con esta identidad.">
              {syncFiscal.isPending ? <Spinner size="sm" /> : 'Aplicar a facturas (Facturapi)'}
            </button>
          </div>
        </Can>
      </section>
    </div>
  )
}

// ── Subcomponentes ────────────────────────────────────────────────────────

function ColorPicker({ label, value, onChange, description, disabled = false }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          className="w-12 h-10 rounded-md border border-line-subtle bg-bg-tertiary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        />
        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          maxLength={7}
          placeholder="#5E9F32"
          className="input font-mono uppercase flex-1"
        />
      </div>
      {description && <p className="text-[10px] text-ink-muted mt-1">{description}</p>}
    </div>
  )
}

// Vista previa simplificada de cómo se verá el PDF de la factura.
function InvoicePreview({ logo, name, primary, secondary }) {
  return (
    <div>
      <p className="eyebrow mb-2">VISTA PREVIA EN FACTURA</p>
      <div className="rounded-md border border-line-subtle overflow-hidden bg-white text-gray-800">
        {/* Banner con color primario */}
        <div className="flex items-center justify-between px-4 py-3" style={{ background: primary }}>
          <div className="flex items-center gap-3">
            {logo ? (
              <img src={logo} alt={name} className="h-9 w-auto max-w-[120px] object-contain bg-white/90 rounded p-1" />
            ) : (
              <div className="h-9 w-9 bg-white/90 rounded text-gray-700 flex items-center justify-center text-xs font-bold">
                {(name || 'E').slice(0, 2).toUpperCase()}
              </div>
            )}
            <span className="text-white font-semibold text-sm">{name || 'Mi Empresa'}</span>
          </div>
          <span className="text-white text-xs font-mono">FACTURA F-2026-0001</span>
        </div>

        {/* Tabla con color secundario para línea */}
        <div className="p-4 text-xs">
          <div className="grid grid-cols-12 gap-2 pb-1 mb-2 border-b-2"
            style={{ borderColor: secondary }}>
            <div className="col-span-7 font-semibold">CONCEPTO</div>
            <div className="col-span-2 font-semibold text-right">CANT</div>
            <div className="col-span-3 font-semibold text-right">IMPORTE</div>
          </div>
          <div className="grid grid-cols-12 gap-2 py-0.5">
            <div className="col-span-7">Producto ejemplo</div>
            <div className="col-span-2 text-right">1</div>
            <div className="col-span-3 text-right font-mono">$1,000.00</div>
          </div>
          <div className="grid grid-cols-12 gap-2 py-0.5">
            <div className="col-span-7">Otro producto</div>
            <div className="col-span-2 text-right">2</div>
            <div className="col-span-3 text-right font-mono">$2,500.00</div>
          </div>
          <div className="flex justify-end pt-3 mt-2 border-t" style={{ borderColor: secondary }}>
            <div className="text-right">
              <div className="text-[10px] text-gray-500">TOTAL MXN</div>
              <div className="text-base font-bold" style={{ color: primary }}>$3,500.00</div>
            </div>
          </div>
        </div>
      </div>
      <p className="text-[10px] text-ink-muted mt-2">
        Vista previa del banner y los detalles. Tras Guardar, así salen los PDFs del
        sistema. El CFDI timbrado toma estos colores al sincronizar con Facturapi.
      </p>
    </div>
  )
}
