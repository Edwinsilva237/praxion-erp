import { Link } from 'react-router-dom'

const SECTIONS = [
  {
    to: '/configuracion/procesos/flags',
    title: 'Flags de proceso',
    description: 'Lotes, FEFO, WIP, calidades, costos, alérgenos y modo operativo',
    color: 'text-brand-400',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
      </svg>
    ),
  },
  {
    to: '/configuracion/procesos/tipos-merma',
    title: 'Tipos de merma',
    description: 'Catálogo de mermas con destino y % de valor de rescate',
    color: 'text-status-warning',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
      </svg>
    ),
  },
  {
    to: '/configuracion/procesos/calidades',
    title: 'Grados de calidad',
    description: 'Niveles de calidad para captura de PT — NRV multi-calidad',
    color: 'text-status-success',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>
      </svg>
    ),
  },
  {
    to: '/configuracion/procesos/unidades',
    title: 'Unidades de medida',
    description: 'Catálogo de unidades — base, conversiones y decimales',
    color: 'text-status-info',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"/>
      </svg>
    ),
  },
  {
    to: '/configuracion/procesos/roles-turno',
    title: 'Roles de turno',
    description: 'Operadores, supervisores y roles de entrega por turno',
    color: 'text-purple-400',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
      </svg>
    ),
  },
  {
    to: '/configuracion/procesos/tipos-producto',
    title: 'Tipos de producto',
    description: 'Categorías con esquemas de atributos y vida útil',
    color: 'text-teal-400',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
      </svg>
    ),
  },
  {
    to: '/configuracion/procesos/alergenos',
    title: 'Alérgenos',
    description: 'Catálogo NOM-051 — controla contaminación cruzada en turnos',
    color: 'text-status-danger',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
      </svg>
    ),
  },
]

export default function Procesos() {
  return (
    <div className="page-enter flex flex-col gap-6">
      <div>
        <h1 className="page-title">Configuración de procesos</h1>
        <p className="page-subtitle">Catálogos y flags del motor de producción SaaS v2</p>
      </div>

      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        Estos ajustes definen <strong>cómo opera el motor de producción</strong> para tu organización.
        Cambios en flags y catálogos afectan turnos futuros. Los turnos ya cerrados conservan su configuración histórica.
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {SECTIONS.map(s => (
          <Link
            key={s.to}
            to={s.to}
            className="card p-5 flex items-start gap-4 hover:bg-surface-elevated/30 transition-colors group"
          >
            <div className={`shrink-0 mt-0.5 ${s.color}`}>{s.icon}</div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-primary group-hover:text-brand-400 transition-colors">
                {s.title}
              </p>
              <p className="text-xs text-ink-muted mt-1 leading-relaxed">{s.description}</p>
            </div>
            <svg className="w-4 h-4 shrink-0 text-ink-muted group-hover:text-brand-400 transition-colors ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
            </svg>
          </Link>
        ))}
      </div>
    </div>
  )
}
