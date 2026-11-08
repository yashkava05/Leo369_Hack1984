// On-device Vision OCR. Image bytes enter via stdin and are never written to a file.
import Foundation
import Vision

let image = FileHandle.standardInput.readDataToEndOfFile()
do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    try VNImageRequestHandler(data: image, options: [:]).perform([request])
    let observations = (request.results ?? []).sorted {
        if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01 {
            return $0.boundingBox.midY > $1.boundingBox.midY
        }
        return $0.boundingBox.minX < $1.boundingBox.minX
    }
    let lines = observations.prefix(500).compactMap { $0.topCandidates(1).first?.string }
    let output = try JSONSerialization.data(withJSONObject: Array(lines))
    FileHandle.standardOutput.write(output)
} catch {
    FileHandle.standardOutput.write(Data("[]".utf8))
}
