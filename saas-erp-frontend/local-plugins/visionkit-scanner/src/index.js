import { registerPlugin } from '@capacitor/core'

/**
 * VisionkitScanner — puente al escáner de documentos nativo de iOS (VisionKit).
 *
 * Método:
 *   scanToPdf({ pageLimit?: number, fileName?: string })
 *     → { uri: string, pageCount: number }   éxito (file:// del PDF generado)
 *     → { cancelled: true }                   el usuario cerró el escáner
 *     → { unsupported: true }                 el device no soporta VisionKit
 *
 * Solo tiene implementación nativa en iOS. En web/Android el caller no debe
 * invocarlo (el hook useDocumentScanner enruta por plataforma).
 */
export const VisionkitScanner = registerPlugin('VisionkitScanner')
