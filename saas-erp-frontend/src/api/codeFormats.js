import api from './axios'

const B = '/code-formats'

export const codeFormatsApi = {
  list:        () => api.get(B).then(r => r.data),
  previewNext: (entity) => api.get(`${B}/preview-next/${entity}`).then(r => r.data),

  upsert: (entity, body) => api.put(`${B}/${entity}`, body).then(r => r.data),
  update: (id, body)     => api.patch(`${B}/${id}`, body).then(r => r.data),
  delete: (id)           => api.delete(`${B}/${id}`).then(r => r.data),
}

// Catálogos soportados — keep en sync con codeFormatService.VALID_ENTITIES
export const ENTITY_TYPES = [
  { value: 'product',      label: 'Productos terminados' },
  { value: 'raw_material', label: 'Materias primas' },
  { value: 'customer',     label: 'Clientes' },
  { value: 'supplier',     label: 'Proveedores' },
]

export const CODE_MODES = [
  { value: 'manual',    label: 'Manual (libre)',       hint: 'El capturista escribe el código sin pista.' },
  { value: 'suggested', label: 'Sugerido',             hint: 'Aparece placeholder y botón "siguiente". El capturista decide.' },
  { value: 'auto',      label: 'Automático',           hint: 'El sistema genera el código; el campo queda solo lectura.' },
]
