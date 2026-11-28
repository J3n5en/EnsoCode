import Foundation

/// EnsoCode QUIC (`enso-pair/1`) 流类型与帧编解码（与 `packages/relay-go/quic.go` 逐字节对齐）。
public enum EnsoQuicStreamKind: UInt8, Sendable {
    case control = 0x00
    case ctrl = 0x01
    case bulk = 0x02
}

public enum EnsoQuicLane: String, Sendable {
    case ctrl
    case bulk
}

public struct EnsoQuicHello: Codable, Equatable, Sendable {
    public let pairId: String
    public let role: String
    public let token: String
    public let relayEpoch: String?
    public let sinceRelaySeq: UInt64?

    public init(
        pairId: String,
        role: String,
        token: String,
        relayEpoch: String? = nil,
        sinceRelaySeq: UInt64? = nil
    ) {
        self.pairId = pairId
        self.role = role
        self.token = token
        self.relayEpoch = relayEpoch
        self.sinceRelaySeq = sinceRelaySeq
    }
}

public enum EnsoQuicCodecError: Error, Equatable {
    case frameTooLarge(Int)
}

/// 4 字节大端长度前缀帧封装，单帧上限 1 MiB（与中继 maxFrameBytes 一致）。
public enum QuicFrameCodec {
    public static let alpn = "enso-pair/1"
    public static let maxFrameBytes = 1_048_576

    public static func encodeFrame(_ payload: Data) throws -> Data {
        guard payload.count <= maxFrameBytes else {
            throw EnsoQuicCodecError.frameTooLarge(payload.count)
        }
        var out = Data(capacity: 4 + payload.count)
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    public static func decodeLengthPrefix(_ header: Data) throws -> Int {
        precondition(header.count == 4, "Header must be exactly 4 bytes")
        let raw = header.withUnsafeBytes { ptr -> UInt32 in
            let b0 = UInt32(ptr[0]) << 24
            let b1 = UInt32(ptr[1]) << 16
            let b2 = UInt32(ptr[2]) << 8
            let b3 = UInt32(ptr[3])
            return b0 | b1 | b2 | b3
        }
        let length = Int(raw)
        guard length <= maxFrameBytes else {
            throw EnsoQuicCodecError.frameTooLarge(length)
        }
        return length
    }
}
