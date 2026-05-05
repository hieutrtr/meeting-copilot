// experimental, not for prod
// T-0.1 — Mic capture spike. Records N seconds from default input via AVAudioEngine
// and writes WAV + JSON metrics. See docs/tasks/phase-0/T-0.1-mic-capture.md.

import Foundation
import AVFoundation

// MARK: - args

let args = CommandLine.arguments
let duration = args.count > 1 ? (Double(args[1]) ?? 10.0) : 10.0
let wavPath = args.count > 2 ? args[2] : "mic.wav"
let metricsPath = args.count > 3 ? args[3] : "metrics.json"

// MARK: - helpers

func writeMetrics(_ dict: [String: Any], to path: String) {
    do {
        // ensure all keys are strings
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: path))
    } catch {
        FileHandle.standardError.write("[fatal] could not write metrics: \(error)\n".data(using: .utf8)!)
    }
}

func nsBetween(_ start: UInt64, _ end: UInt64) -> UInt64 {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    if end <= start { return 0 }
    return (end - start) * UInt64(info.numer) / UInt64(info.denom)
}

func log(_ s: String) {
    print(s)
    fflush(stdout)
}

log("[boot] mic_capture starting (duration=\(duration)s, wav=\(wavPath))")

// MARK: - TCC authorization probe (fast, non-blocking)
// `authorizationStatus` is a pure query — never prompts, never hangs. Use it as a
// pre-flight so we fail fast & explicit when permission is missing, instead of
// relying on the watchdog to rescue us.
let authStatus = AVCaptureDevice.authorizationStatus(for: .audio)
let authStatusName: String = {
    switch authStatus {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown(\(authStatus.rawValue))"
    }
}()
log("[tcc] mic authorization status: \(authStatusName)")

if authStatus != .authorized {
    log("[error] microphone TCC status is '\(authStatusName)' — capture will not work in headless mode")
    log("[hint] grant Microphone access to the parent terminal in System Settings → Privacy & Security → Microphone, then re-run")
    writeMetrics([
        "ok": false,
        "error": "tcc_not_authorized",
        "tcc_status": authStatusName,
        "duration_seconds_requested": duration,
        "hint": "Microphone permission not granted (status='\(authStatusName)'). Grant the parent terminal Microphone access in System Settings → Privacy & Security → Microphone, then re-run. If status is 'notDetermined', running this binary once interactively from a GUI terminal will surface the macOS permission prompt."
    ], to: metricsPath)
    exit(6)
}

// MARK: - watchdog
// AVAudioEngine APIs can still block in edge cases (device disconnect, sandbox quirks).
// Watchdog guarantees we always emit metrics and exit even if the happy path stalls.
let watchdogSeconds = duration + 8.0
DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + watchdogSeconds) {
    FileHandle.standardError.write("[watchdog] hard timeout after \(watchdogSeconds)s — likely TCC blocked, no audio buffers received\n".data(using: .utf8)!)
    writeMetrics([
        "ok": false,
        "error": "tcc_watchdog_timeout",
        "watchdog_seconds": watchdogSeconds,
        "duration_seconds_requested": duration,
        "hint": "AVAudioEngine never returned audio in time. Most common cause: microphone permission not granted to the running terminal/binary. Grant in System Settings → Privacy & Security → Microphone for the executing terminal app, then re-run."
    ], to: metricsPath)
    _exit(5)
}

// MARK: - probe input device

log("[boot] creating AVAudioEngine...")
let engine = AVAudioEngine()
log("[boot] querying inputNode...")
let input = engine.inputNode
let inputFormat = input.outputFormat(forBus: 0)
log("[info] input native format: sampleRate=\(inputFormat.sampleRate) Hz, channels=\(inputFormat.channelCount), commonFormat=\(inputFormat.commonFormat.rawValue)")

guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
    log("[error] input format invalid (sampleRate=\(inputFormat.sampleRate), channels=\(inputFormat.channelCount))")
    log("[hint] microphone permission likely denied or no input device. Grant in System Settings → Privacy & Security → Microphone.")
    writeMetrics([
        "ok": false,
        "error": "invalid_input_format",
        "sample_rate_hz": inputFormat.sampleRate,
        "channels": inputFormat.channelCount,
        "hint": "Microphone permission denied or no input device available. Grant in System Settings → Privacy & Security → Microphone for the running terminal/process, then re-run."
    ], to: metricsPath)
    exit(2)
}

// MARK: - prepare output WAV (caf-wrapped float32 LPCM, written via AVAudioFile at native fmt)

let outURL = URL(fileURLWithPath: wavPath)
try? FileManager.default.removeItem(at: outURL)

let wavSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: inputFormat.sampleRate,
    AVNumberOfChannelsKey: inputFormat.channelCount,
    AVLinearPCMBitDepthKey: 32,
    AVLinearPCMIsFloatKey: true,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false
]

let audioFile: AVAudioFile
do {
    audioFile = try AVAudioFile(forWriting: outURL,
                                settings: wavSettings,
                                commonFormat: .pcmFormatFloat32,
                                interleaved: false)
} catch {
    log("[error] AVAudioFile open failed: \(error)")
    writeMetrics([
        "ok": false,
        "error": "audio_file_open_failed",
        "detail": "\(error)"
    ], to: metricsPath)
    exit(3)
}

// MARK: - tap & metrics

let metricsLock = NSLock()
var callbackCount = 0
var sampleCount: Int64 = 0
var firstCallbackHostTime: UInt64 = 0
var lastBufferEndSample: Int64 = -1
var glitchCount = 0
var totalGapSamples: Int64 = 0
var bufferSizeHistogram: [UInt32: Int] = [:]
var writeErrors = 0
var lastSamplePeak: Float = 0
var maxSamplePeak: Float = 0

let startHostTime = mach_absolute_time()

input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, time in
    metricsLock.lock()
    defer { metricsLock.unlock() }

    if callbackCount == 0 {
        firstCallbackHostTime = time.hostTime
    }
    callbackCount += 1
    sampleCount += Int64(buffer.frameLength)
    bufferSizeHistogram[buffer.frameLength, default: 0] += 1

    // Gap / glitch detection via sampleTime continuity
    let bufferStart = time.sampleTime
    if lastBufferEndSample >= 0 {
        let gap = bufferStart - lastBufferEndSample
        if gap > 0 {
            glitchCount += 1
            totalGapSamples += gap
            FileHandle.standardError.write("[glitch] cb#\(callbackCount): gap=\(gap) samples between buffers\n".data(using: .utf8)!)
        }
    }
    lastBufferEndSample = bufferStart + Int64(buffer.frameLength)

    // Peak amplitude (cheap signal-presence check)
    if let chData = buffer.floatChannelData {
        let frames = Int(buffer.frameLength)
        var peak: Float = 0
        let ch0 = chData[0]
        for i in 0..<frames {
            let v = abs(ch0[i])
            if v > peak { peak = v }
        }
        lastSamplePeak = peak
        if peak > maxSamplePeak { maxSamplePeak = peak }
    }

    do {
        try audioFile.write(from: buffer)
    } catch {
        writeErrors += 1
        FileHandle.standardError.write("[error] write failed: \(error)\n".data(using: .utf8)!)
    }
}

// MARK: - run

do {
    try engine.start()
} catch {
    log("[error] engine.start failed: \(error)")
    writeMetrics([
        "ok": false,
        "error": "engine_start_failed",
        "detail": "\(error.localizedDescription)",
        "hint": "If this mentions kAudioHardwareIllegalOperationError or 0x6e6f7065 ('nope'), microphone permission is denied. Grant it for the parent terminal, then re-run."
    ], to: metricsPath)
    exit(4)
}

log("[info] recording \(duration)s → \(wavPath)")
Thread.sleep(forTimeInterval: duration)

input.removeTap(onBus: 0)
engine.stop()

let endHostTime = mach_absolute_time()
let elapsedNs = nsBetween(startHostTime, endHostTime)
let firstCallbackNs = firstCallbackHostTime > startHostTime ? nsBetween(startHostTime, firstCallbackHostTime) : 0

// MARK: - emit

let histogramJson: [String: Int] = Dictionary(uniqueKeysWithValues: bufferSizeHistogram.map { (String($0.key), $0.value) })

let approxRecordedSeconds = Double(sampleCount) / inputFormat.sampleRate
let signalPresent = maxSamplePeak > 0.001  // -60 dBFS

let metrics: [String: Any] = [
    "ok": callbackCount > 0,
    "duration_seconds_requested": duration,
    "wallclock_seconds": Double(elapsedNs) / 1_000_000_000.0,
    "audio_seconds_recorded": approxRecordedSeconds,
    "sample_rate_hz": inputFormat.sampleRate,
    "channels": Int(inputFormat.channelCount),
    "callback_count": callbackCount,
    "sample_count": sampleCount,
    "first_callback_latency_ms": Double(firstCallbackNs) / 1_000_000.0,
    "glitch_count": glitchCount,
    "total_gap_samples": totalGapSamples,
    "buffer_size_histogram": histogramJson,
    "write_errors": writeErrors,
    "max_sample_peak": Double(maxSamplePeak),
    "signal_present": signalPresent,
    "output_wav_path": wavPath,
    "input_format_description": "\(inputFormat)"
]
writeMetrics(metrics, to: metricsPath)

if callbackCount == 0 {
    log("[warn] zero callbacks fired — engine started but no audio frames received. Likely TCC blocking the input device silently.")
}

log("[ok] callbacks=\(callbackCount), samples=\(sampleCount) (~\(String(format: "%.2f", approxRecordedSeconds))s), first-cb-latency=\(String(format: "%.1f", Double(firstCallbackNs) / 1_000_000.0))ms, glitches=\(glitchCount), peak=\(String(format: "%.4f", maxSamplePeak)), wav=\(wavPath)")
exit(0)
