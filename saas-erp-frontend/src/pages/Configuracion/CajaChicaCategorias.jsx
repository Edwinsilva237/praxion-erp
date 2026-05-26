import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { pettyCashApi } from '@/api/pettyCash'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

export default function CajaChicaCategorias() {
  return (
    <div className="page-enter max-w-4xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Categorías de caja chica</h1>
        <p className="text-sm text-ink-muted mt-1">
          Clasifica los movimientos para reportes y análisis. Las categorías están
          separadas entre <strong>entradas</strong> (reabastecimientos) y <strong>salidas</strong> (gastos).
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <CategoryList kind="in"  title="Entradas (reabastecimientos)" placeholder="Ej. Aportación de socio, Devolución..." />
        <CategoryList kind="out" title="Salidas (gastos)" placeholder="Ej. Papelería, Combustible, Transporte..." />
      </div>
    </div>
  )
}

function CategoryList({ kind, title, placeholder }) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [error, setError]     = useState(null)

  const { data: resp, isLoading } = useQuery({
    queryKey: ['petty-cash', 'categories', kind, { includeInactive: true }],
    queryFn:  () => pettyCashApi.listCategories({ kind, includeInactive: true }),
  })
  const cats = resp?.data || []

  const createMut = useMutation({
    mutationFn: () => {
      if (!newName.trim()) throw new Error('Captura un nombre.')
      return pettyCashApi.createCategory({ name: newName.trim(), kind })
    },
    onSuccess: () => {
      setNewName('')
      qc.invalidateQueries({ queryKey: ['petty-cash', 'categories'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error'),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }) => pettyCashApi.updateCategory(id, { isActive }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['petty-cash', 'categories'] }),
  })

  const renameMut = useMutation({
    mutationFn: ({ id, name }) => pettyCashApi.updateCategory(id, { name }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['petty-cash', 'categories'] }),
  })

  return (
    <div className="card p-4 flex flex-col gap-3">
      <h3 className={clsx('text-sm font-semibold',
        kind === 'in' ? 'text-status-success' : 'text-status-danger')}>
        {title}
      </h3>

      <form className="flex gap-2"
        onSubmit={e => { e.preventDefault(); setError(null); createMut.mutate() }}>
        <input className="input flex-1" value={newName}
          onChange={e => setNewName(e.target.value)} placeholder={placeholder} />
        <button type="submit" disabled={createMut.isPending} className="btn-secondary btn-sm">
          {createMut.isPending ? <Spinner size="sm" /> : '+ Agregar'}
        </button>
      </form>
      {error && <p className="field-error">{error}</p>}

      {isLoading ? (
        <Spinner />
      ) : cats.length === 0 ? (
        <p className="text-xs text-ink-muted italic">Sin categorías capturadas.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {cats.map(c => (
            <CategoryRow key={c.id} category={c}
              onToggle={isActive => toggleMut.mutate({ id: c.id, isActive })}
              onRename={name => renameMut.mutate({ id: c.id, name })} />
          ))}
        </ul>
      )}
    </div>
  )
}

function CategoryRow({ category, onToggle, onRename }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(category.name)

  function handleSave() {
    if (name.trim() && name.trim() !== category.name) {
      onRename(name.trim())
    }
    setEditing(false)
  }

  return (
    <li className={clsx('flex items-center gap-2 py-1.5 border-b border-line-subtle last:border-0',
      !category.is_active && 'opacity-50')}>
      {editing ? (
        <input className="input flex-1 text-sm" value={name} autoFocus
          onChange={e => setName(e.target.value)}
          onBlur={handleSave}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setName(category.name); setEditing(false) } }} />
      ) : (
        <button onClick={() => setEditing(true)}
          className="flex-1 text-left text-sm text-ink-primary hover:text-brand-300">
          {category.name}
        </button>
      )}
      <button onClick={() => onToggle(!category.is_active)}
        className={clsx('text-[10px] font-bold uppercase px-2 py-1 rounded',
          category.is_active ? 'text-status-success hover:bg-status-success/10'
                             : 'text-ink-muted hover:bg-surface-elevated/40')}>
        {category.is_active ? 'Activa' : 'Inactiva'}
      </button>
    </li>
  )
}
