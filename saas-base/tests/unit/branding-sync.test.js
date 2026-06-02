'use strict'

/**
 * Unit test del sync de branding tenant → Facturapi (brandingService).
 * Mockea el SDK de Facturapi y la capa de BD para verificar que se llaman los
 * métodos CORRECTOS del SDK v4:
 *   - color  → organizations.updateCustomization(orgId, { color })
 *   - logo   → organizations.uploadLogo(orgId, <Buffer>)
 * (Antes el color llamaba organizations.update(), método inexistente en v4 →
 * los colores nunca llegaban al CFDI. Este test atrapa esa regresión.)
 */

const mockUpdateCustomization = jest.fn().mockResolvedValue({})
const mockUploadLogo          = jest.fn().mockResolvedValue({})

jest.mock('facturapi', () => ({
  default: class FakeFacturapi {
    constructor() {
      this.organizations = {
        updateCustomization: mockUpdateCustomization,
        uploadLogo:          mockUploadLogo,
      }
    }
  },
}))
jest.mock('../../src/db', () => ({ query: jest.fn() }))
jest.mock('../../src/utils/storage', () => ({ fetchBuffer: jest.fn() }))

const { query } = require('../../src/db')
const storage   = require('../../src/utils/storage')
const branding  = require('../../src/modules/tenants/brandingService')

describe('brandingService — sincronización de branding con Facturapi', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.FACTURAPI_USER_KEY = 'sk_user_test'
  })

  test('syncColors llama updateCustomization con el color PRIMARIO', async () => {
    query.mockResolvedValueOnce({ rows: [{ facturapi_organization_id: 'org_abc' }] })
    const r = await branding.syncColors('tenant-1', { primary: '#5E9F32', secondary: '#3F7324' })
    expect(r).toEqual({ synced: true, orgId: 'org_abc' })
    expect(mockUpdateCustomization).toHaveBeenCalledWith('org_abc', { color: '#5E9F32' })
  })

  test('syncColors es no-op si el tenant no tiene organización fiscal', async () => {
    query.mockResolvedValueOnce({ rows: [{ facturapi_organization_id: null }] })
    const r = await branding.syncColors('tenant-1', { primary: '#fff' })
    expect(r).toEqual({ synced: false, reason: 'sin_organizacion_fiscal' })
    expect(mockUpdateCustomization).not.toHaveBeenCalled()
  })

  test('syncLogo sube el buffer del logo vía uploadLogo', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ facturapi_organization_id: 'org_abc' }] })   // getOrgId
      .mockResolvedValueOnce({ rows: [{ logo_storage_path: 'public/logo.png' }] })   // logo path
    storage.fetchBuffer.mockResolvedValueOnce(Buffer.from('PNGDATA'))
    const r = await branding.syncLogo('tenant-1')
    expect(r).toEqual({ synced: true, orgId: 'org_abc' })
    expect(mockUploadLogo).toHaveBeenCalledWith('org_abc', expect.any(Buffer))
  })
})
