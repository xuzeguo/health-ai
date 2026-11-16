import Foundation
import NaturalLanguage
import Vision
import AppKit

// Parent captures stdout in memory; never log OCR text or vectors to reports.
func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

let args = CommandLine.arguments
do {
    if args.count >= 3 && args[1] == "embedding" {
        guard let embedding = NLEmbedding.sentenceEmbedding(for: .simplifiedChinese) else {
            try emit(["available": false, "reason": "CHINESE_SENTENCE_MODEL_UNAVAILABLE"])
            exit(2)
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: args[2]))
        guard let texts = try JSONSerialization.jsonObject(with: data) as? [String] else { exit(3) }
        let vectors = texts.map { embedding.vector(for: $0) }
        guard vectors.allSatisfy({ $0 != nil }) else { exit(4) }
        try emit(["available": true, "dimension": embedding.dimension, "revision": embedding.revision, "vectors": vectors.map { $0! }])
    } else if args.count >= 3 && args[1] == "ocr" {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath: args[2]))
        try handler.perform([request])
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        try emit(["available": true, "lines": lines])
    } else if args.count >= 3 && args[1] == "fixtures" {
        let directory = URL(fileURLWithPath: args[2])
        for layout in 1...2 {
            let image = NSImage(size: NSSize(width: 1200, height: 800))
            image.lockFocus()
            NSColor.white.setFill()
            NSRect(x: 0, y: 0, width: 1200, height: 800).fill()
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .left
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 38), .foregroundColor: NSColor.black, .paragraphStyle: paragraph]
            let lines = layout == 1 ? ["合成身体成分报告 A", "测量日期 2026-10-01", "体重 70.2 kg", "体脂率 18.5 %", "骨骼肌量 32.1 kg"] :
                ["合成身体成分报告 B", "2026-10-15", "Weight 69.8 kg", "Body Fat 18.0 %", "Skeletal Muscle 32.3 kg"]
            for (index, line) in lines.enumerated() {
                let x = layout == 2 && index > 1 ? 160.0 : 60.0
                (line as NSString).draw(at: NSPoint(x: x, y: 690 - Double(index) * 110), withAttributes: attrs)
            }
            image.unlockFocus()
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else { exit(5) }
            try png.write(to: directory.appendingPathComponent("report-\(layout).png"))
        }
        try emit(["generated": 2])
    } else {
        try emit(["error": "INVALID_MODE"])
        exit(2)
    }
} catch {
    // Framework errors may contain local paths or source text; expose classification only.
    try? emit(["error": "LOCAL_CAPABILITY_FAILED"])
    exit(1)
}
