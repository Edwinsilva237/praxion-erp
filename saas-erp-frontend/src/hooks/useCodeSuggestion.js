import { useQuery } from '@tanstack/react-query'
import { codeFormatsApi } from '@/api/codeFormats'

/**
 * Hook para integrar la nomenclatura de códigos en cualquier form sin
 * importar si usa react-hook-form, useState o lo que sea.
 *
 * Uso:
 *   const sug = useCodeSuggestion('product')
 *
 *   <input value={sku} onChange={...} placeholder={sug.placeholder} disabled={sug.isAuto} />
 *   {sug.canSuggest && <button onClick={() => setSku(sug.code)}>Sugerir {sug.code}</button>}
 *
 * Modos:
 *   - manual / sin config → { code:null, mode:'manual', canSuggest:false, isAuto:false, placeholder:'' }
 *   - suggested  → { code:'CLI-0042', mode:'suggested', canSuggest:true,  placeholder:'CLI-0042' }
 *   - auto       → { code:'CLI-0042', mode:'auto',      isAuto:true,     placeholder:'CLI-0042' }
 *
 * El frontend NO consume el siguiente número — solo lo muestra. El backend
 * consume cuando el caller llama al endpoint de create del catálogo.
 * El siguiente código se refresca al volver a abrir el form (staleTime 30s).
 */
export function useCodeSuggestion(entityType, options = {}) {
  const { enabled = true } = options
  const { data, isLoading } = useQuery({
    queryKey: ['code-format-preview', entityType],
    queryFn:  () => codeFormatsApi.previewNext(entityType),
    enabled:  !!entityType && enabled,
    staleTime: 30_000,
  })

  const mode = data?.mode || 'manual'
  const code = data?.code || null

  return {
    code,
    mode,
    isAuto:      mode === 'auto' && !!code,
    canSuggest:  mode === 'suggested' && !!code,
    placeholder: code || '',
    isLoading,
    raw:         data || null,
  }
}
