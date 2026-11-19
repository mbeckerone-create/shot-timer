import SwiftUI

func timecode(_ t: TimeInterval, tenths: Bool = false) -> String {
    let total = max(0, t)
    let h = Int(total) / 3600, m = (Int(total) % 3600) / 60, s = Int(total) % 60
    if tenths { return String(format: "%02d:%02d:%02d.%d", h, m, s, Int((total * 10).truncatingRemainder(dividingBy: 10))) }
    return String(format: "%02d:%02d:%02d", h, m, s)
}

func dB(_ linear: Float) -> Float { linear > 0 ? 20 * log10(linear) : -120 }

/// Maps a linear peak to 0...1 meter position over a -60 dB…0 dB range.
func meterPosition(_ linear: Float) -> CGFloat {
    CGFloat(min(1, max(0, (dB(linear) + 60) / 60)))
}
