import ImageIO
import UIKit
import UniformTypeIdentifiers

enum ImageCompress {
  static let maxBytes = 700_000
  static let maxEdge: CGFloat = 1600

  static func compress(_ image: UIImage) throws -> AttachedImage {
    let scaled = scale(image, maxEdge: maxEdge)
    for quality in [0.85, 0.7, 0.55, 0.4] as [CGFloat] {
      guard let data = scaled.jpegData(compressionQuality: quality) else { continue }
      if data.count <= maxBytes {
        return AttachedImage(data: data.base64EncodedString(), mimeType: "image/jpeg")
      }
    }
    throw CompressError.tooLarge
  }

  static func compressIfNeeded(_ image: AttachedImage) throws -> AttachedImage {
    let approx = image.data.count * 3 / 4
    if approx <= maxBytes { return image }
    guard let data = Data(base64Encoded: image.data), let ui = UIImage(data: data) else { return image }
    return try compress(ui)
  }

  private static func scale(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
    let size = image.size
    let longest = max(size.width, size.height)
    guard longest > maxEdge, longest > 0 else { return image }
    let scale = maxEdge / longest
    let newSize = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    let renderer = UIGraphicsImageRenderer(size: newSize)
    return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: newSize)) }
  }

  enum CompressError: LocalizedError {
    case tooLarge
    var errorDescription: String? { "图片太大，请换一张更小的图" }
  }
}
