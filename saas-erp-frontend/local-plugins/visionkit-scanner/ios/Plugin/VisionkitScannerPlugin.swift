import Foundation
import Capacitor
import VisionKit
import PDFKit

/**
 * Escáner de documentos nativo de iOS usando VisionKit
 * (VNDocumentCameraViewController — el mismo de Notas/Archivos de Apple:
 * detección de bordes, auto-recorte, corrección de perspectiva, multipágina).
 *
 * Junta las páginas escaneadas en un PDF temporal y devuelve su file:// URI,
 * con la misma forma de salida que el plugin de Android (ML Kit) para que el
 * hook useDocumentScanner trate ambas plataformas igual.
 */
@objc(VisionkitScannerPlugin)
public class VisionkitScannerPlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate {
    public let identifier = "VisionkitScannerPlugin"
    public let jsName = "VisionkitScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scanToPdf", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var pageLimit: Int = 0
    private var fileName: String = "documento-escaneado.pdf"

    @objc func scanToPdf(_ call: CAPPluginCall) {
        guard VNDocumentCameraViewController.isSupported else {
            call.resolve(["unsupported": true])
            return
        }
        self.pendingCall = call
        self.pageLimit = call.getInt("pageLimit") ?? 0
        self.fileName = call.getString("fileName") ?? "documento-escaneado.pdf"

        DispatchQueue.main.async {
            let scanner = VNDocumentCameraViewController()
            scanner.delegate = self
            self.bridge?.viewController?.present(scanner, animated: true)
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                             didFinishWith scan: VNDocumentCameraScan) {
        let limit = self.pageLimit
        let name = self.fileName
        let call = self.pendingCall
        controller.dismiss(animated: true) {
            guard let call = call else { return }
            let total = scan.pageCount
            let maxPages = limit > 0 ? min(total, limit) : total

            let pdf = PDFDocument()
            for i in 0..<maxPages {
                let image = scan.imageOfPage(at: i)
                if let page = PDFPage(image: image) {
                    pdf.insert(page, at: pdf.pageCount)
                }
            }

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + "-" + name)

            if pdf.pageCount > 0 && pdf.write(to: url) {
                call.resolve(["uri": url.absoluteString, "pageCount": maxPages])
            } else {
                call.reject("No se pudo generar el PDF del documento escaneado")
            }
            self.pendingCall = nil
        }
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        let call = self.pendingCall
        controller.dismiss(animated: true) {
            call?.resolve(["cancelled": true])
            self.pendingCall = nil
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                             didFailWithError error: Error) {
        let call = self.pendingCall
        controller.dismiss(animated: true) {
            call?.reject(error.localizedDescription)
            self.pendingCall = nil
        }
    }
}
