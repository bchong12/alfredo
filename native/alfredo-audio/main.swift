// alfredo-audio: system audio and the microphone to two wav files, no driver.
//
//   alfredo-audio record <dir> [--mic-only]
//                                  writes <dir>/system.wav and <dir>/mic.wav
//                                  until SIGINT or SIGTERM, then finalises.
//                                  --mic-only skips system audio entirely.
//   alfredo-audio check             prints "ok" if Screen Recording is granted,
//                                  else asks macOS for it and prints "asked".
//
// System audio comes from ScreenCaptureKit (macOS 13+), which is how the OS
// itself records a screen with sound; no kernel extension, no virtual device.
// The microphone comes from AVAudioEngine. Both are 16 kHz mono PCM, which is
// what the transcriber wants.

import AVFoundation
import CoreAudio
import CoreGraphics
import Foundation
import ScreenCaptureKit

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: alfredo-audio record <dir> | check\n".data(using: .utf8)!)
  exit(2)
}

// --- wav writer ------------------------------------------------------------------

final class WavWriter {
  let handle: FileHandle
  var frames: UInt32 = 0
  let rate: UInt32
  init(path: String, rate: UInt32) throws {
    FileManager.default.createFile(atPath: path, contents: nil)
    handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
    self.rate = rate
    handle.write(Data(count: 44))
  }
  func write(_ samples: [Int16]) {
    samples.withUnsafeBufferPointer { handle.write(Data(buffer: $0)) }
    frames += UInt32(samples.count)
  }
  func close() {
    var d = Data()
    func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
    let bytes = frames * 2
    d.append("RIFF".data(using: .ascii)!); u32(36 + bytes); d.append("WAVE".data(using: .ascii)!)
    d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
    d.append("data".data(using: .ascii)!); u32(bytes)
    handle.seek(toFileOffset: 0)
    handle.write(d)
    try? handle.close()
  }
}

/// Resample any float PCM to 16 kHz mono int16, cheaply (linear).
final class Down {
  let inRate: Double
  var carry: Double = 0
  init(inRate: Double) { self.inRate = inRate }
  func process(_ mono: [Float]) -> [Int16] {
    let ratio = inRate / 16000.0
    var out: [Int16] = []
    out.reserveCapacity(Int(Double(mono.count) / ratio) + 2)
    var pos = carry
    while pos < Double(mono.count) {
      let i = Int(pos)
      let f = Float(pos - Double(i))
      let a = mono[i]
      let b = i + 1 < mono.count ? mono[i + 1] : a
      let v = a + (b - a) * f
      out.append(Int16(max(-1, min(1, v)) * 32767))
      pos += ratio
    }
    carry = pos - Double(mono.count)
    return out
  }
}

// --- check -------------------------------------------------------------------------

if args[1] == "check" {
  if CGPreflightScreenCaptureAccess() { print("ok") } else { CGRequestScreenCaptureAccess(); print("asked") }
  exit(0)
}

// --- probe: is a call going on? ----------------------------------------------------------
//
// Asks nothing of the person. The microphone being open in some other process
// is what a call looks like from here; the window list says which app, when
// Alfredo may read window names (the same permission as recording the call).
if args[1] == "probe" {
  var micInUse = false
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var dev = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev) == noErr, dev != 0 {
    var running: UInt32 = 0
    var rsize = UInt32(MemoryLayout<UInt32>.size)
    var raddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    if AudioObjectGetPropertyData(dev, &raddr, 0, nil, &rsize, &running) == noErr { micInUse = running != 0 }
  }
  let screen = CGPreflightScreenCaptureAccess()
  var calls: [[String: String]] = []
  if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
    for w in list {
      let owner = w[kCGWindowOwnerName as String] as? String ?? ""
      let name = w[kCGWindowName as String] as? String ?? ""
      let text = owner + " " + name
      var what: String? = nil
      if name.range(of: #"(^|\s)Meet\s[-–—]|Google Meet|meet\.google\.com"#, options: .regularExpression) != nil { what = "Google Meet" }
      else if owner == "zoom.us" || name.contains("Zoom Meeting") || name.contains("Zoom Webinar") { what = "Zoom" }
      else if owner.contains("Microsoft Teams") || name.contains("Microsoft Teams") { what = "Microsoft Teams" }
      else if owner == "FaceTime" { what = "FaceTime" }
      else if name.contains("Huddle") && (owner == "Slack" || name.contains("Slack")) { what = "a Slack huddle" }
      else if name.contains("Webex") { what = "Webex" }
      else if name.contains("Discord") && name.contains("Voice") { what = "Discord" }
      if let what = what, !calls.contains(where: { $0["app"] == what }) { calls.append(["app": what, "title": String(text.prefix(80))]) }
    }
  }
  let json: [String: Any] = ["micInUse": micInUse, "screen": screen, "calls": calls]
  if let data = try? JSONSerialization.data(withJSONObject: json), let text = String(data: data, encoding: .utf8) { print(text) }
  exit(0)
}

guard args[1] == "record", args.count >= 3 else { exit(2) }
let dir = args[2]
let micOnly = args.contains("--mic-only")
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

// --- microphone ---------------------------------------------------------------------

let engine = AVAudioEngine()
let micWriter = try WavWriter(path: dir + "/mic.wav", rate: 16000)
let micFormat = engine.inputNode.outputFormat(forBus: 0)
let micDown = Down(inRate: micFormat.sampleRate)
engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buf, _ in
  guard let ch = buf.floatChannelData else { return }
  let n = Int(buf.frameLength)
  var mono = [Float](repeating: 0, count: n)
  let chans = Int(buf.format.channelCount)
  for c in 0..<chans { for i in 0..<n { mono[i] += ch[c][i] / Float(chans) } }
  micWriter.write(micDown.process(mono))
}
do { try engine.start() } catch {
  FileHandle.standardError.write("mic: \(error)\n".data(using: .utf8)!)
}

// --- system audio ---------------------------------------------------------------------

let sysWriter = try WavWriter(path: dir + "/system.wav", rate: 16000)
var sysDown: Down? = nil
var stream: SCStream? = nil

final class Out: NSObject, SCStreamOutput, SCStreamDelegate {
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, let fmt = sb.formatDescription, let asbd = fmt.audioStreamBasicDescription else { return }
    if sysDown == nil { sysDown = Down(inRate: asbd.mSampleRate) }
    var blockBuffer: CMBlockBuffer? = nil
    var list = AudioBufferList()
    var size = 0
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sb, bufferListSizeNeededOut: &size, bufferListOut: &list, bufferListSize: MemoryLayout<AudioBufferList>.size,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &blockBuffer)
    guard status == noErr else { return }
    let frames = Int(CMSampleBufferGetNumSamples(sb))
    let chans = Int(asbd.mChannelsPerFrame)
    var mono = [Float](repeating: 0, count: frames)
    let buffers = UnsafeMutableAudioBufferListPointer(&list)
    if buffers.count >= chans && chans > 1 {
      // Non-interleaved: one buffer per channel.
      for b in buffers { guard let p = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
        for i in 0..<min(frames, Int(b.mDataByteSize) / 4) { mono[i] += p[i] / Float(chans) } }
    } else if let b = buffers.first, let p = b.mData?.assumingMemoryBound(to: Float.self) {
      let total = Int(b.mDataByteSize) / 4
      if chans > 1 { for i in 0..<min(frames, total / chans) { var s: Float = 0; for c in 0..<chans { s += p[i * chans + c] }; mono[i] = s / Float(chans) } }
      else { for i in 0..<min(frames, total) { mono[i] = p[i] } }
    }
    sysWriter.write(sysDown!.process(mono))
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("system audio stopped: \(error)\n".data(using: .utf8)!)
  }
}
let out = Out()

Task {
  if micOnly {
    print("mic-only")
    fflush(stdout)
    return
  }
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else { throw NSError(domain: "alfredo", code: 1) }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.capturesAudio = true
    cfg.excludesCurrentProcessAudio = true
    cfg.sampleRate = 48000
    cfg.channelCount = 2
    // Video is unavoidable in a stream; make it as cheap as possible.
    cfg.width = 2
    cfg.height = 2
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    cfg.showsCursor = false
    let s = SCStream(filter: filter, configuration: cfg, delegate: out)
    try s.addStreamOutput(out, type: .audio, sampleHandlerQueue: DispatchQueue(label: "alfredo.audio"))
    try await s.startCapture()
    stream = s
    print("recording")
    fflush(stdout)
  } catch {
    FileHandle.standardError.write("system audio unavailable: \(error)\n".data(using: .utf8)!)
    print("mic-only")
    fflush(stdout)
  }
}

// --- stop on signal ---------------------------------------------------------------------

let stopper = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let stopper2 = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
func finish() {
  engine.stop()
  let group = DispatchGroup()
  if let s = stream { group.enter(); Task { try? await s.stopCapture(); group.leave() } }
  _ = group.wait(timeout: .now() + 3)
  micWriter.close()
  sysWriter.close()
  print("done")
  exit(0)
}
stopper.setEventHandler(handler: finish); stopper.resume()
stopper2.setEventHandler(handler: finish); stopper2.resume()
RunLoop.main.run()
