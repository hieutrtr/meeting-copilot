// experimental, not for prod
// T-0.2 — BlackHole 2ch loopback capture spike. Enumerates Core Audio input devices,
// finds BlackHole-2ch, points AVAudioEngine at it, records N seconds, measures
// glitch / dropout / peak. See docs/tasks/phase-0/T-0.2-blackhole-loopback.md.

import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

// MARK: - args

let args = CommandLine.arguments
let duration = args.count > 1 ? (Double(args[1]) ?? 60.0) : 60.0
let wavPath = args.count > 2 ? args[2] : "blackhole.wav"
let metricsPath = args.count > 3 ? args[3] : "metrics.json"

// MARK: - helpers

func writeMetrics(_ dict: [String: Any], to path: String) {
    do {
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

log("[boot] blackhole_capture starting (duration=\(duration)s, wav=\(wavPath))")

// MARK: - Core Audio device enumeration

struct DeviceInfo {
    let id: AudioDeviceID
    let uid: String
    let name: String
    let inputChannels: Int
    let nominalSampleRate: Double
}

func cfStringForProperty(_ deviceID: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    if AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) != noErr { return "" }
    var cfStr: CFString? = nil
    let status = withUnsafeMutablePointer(to: &cfStr) { ptr -> OSStatus in
        ptr.withMemoryRebound(to: CFString?.self, capacity: 1) { typedPtr in
            AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, typedPtr)
        }
    }
    if status == noErr, let s = cfStr { return s as String }
    return ""
}

func inputChannelCount(_ deviceID: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    if AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) != noErr { return 0 }
    let bufferList = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { bufferList.deallocate() }
    if AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, bufferList) != noErr { return 0 }
    let abl = UnsafeMutableAudioBufferListPointer(bufferList)
    return abl.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func nominalSampleRate(_ deviceID: AudioDeviceID) -> Double {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(MemoryLayout<Float64>.size)
    var rate: Float64 = 0
    if AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &rate) != noErr { return 0 }
    return rate
}

func enumerateDevices() -> [DeviceInfo] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr,
          size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    let status = ids.withUnsafeMutableBufferPointer { ptr -> OSStatus in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, ptr.baseAddress!)
    }
    guard status == noErr else { return [] }
    return ids.map { id in
        DeviceInfo(
            id: id,
            uid: cfStringForProperty(id, kAudioDevicePropertyDeviceUID),
            name: cfStringForProperty(id, kAudioObjectPropertyName),
            inputChannels: inputChannelCount(id),
            nominalSampleRate: nominalSampleRate(id)
        )
    }
}

let allDevices = enumerateDevices()
let inputDevices = allDevices.filter { $0.inputChannels > 0 }

log("[probe] all CoreAudio devices: \(allDevices.count) (input-capable: \(inputDevices.count))")
for d in inputDevices {
    log("[probe]   in \(d.id) name=\"\(d.name)\" uid=\"\(d.uid)\" ch=\(d.inputChannels) sr=\(d.nominalSampleRate)")
}

let deviceListJson: [[String: Any]] = inputDevices.map { d in
    [
        "id": Int(d.id),
        "name": d.name,
        "uid": d.uid,
        "input_channels": d.inputChannels,
        "nominal_sample_rate_hz": d.nominalSampleRate
    ]
}

// MARK: - locate BlackHole-2ch

func findBlackHole(_ devices: [DeviceInfo]) -> DeviceInfo? {
    // Match either by name (canonical "BlackHole 2ch") or by UID prefix that the
    // installer uses ("BlackHole2ch_UID"). Case-insensitive name match in case
    // of locale variants.
    return devices.first { d in
        let name = d.name.lowercased()
        let uid = d.uid
        return (name.contains("blackhole 2ch") || name.contains("blackhole2ch") || uid.contains("BlackHole2ch_UID"))
            && d.inputChannels >= 2
    }
}

guard let blackhole = findBlackHole(inputDevices) else {
    log("[error] BlackHole-2ch not found among input devices")
    log("[hint] install with: brew install blackhole-2ch  (then approve system extension in Privacy & Security and reboot if prompted)")
    writeMetrics([
        "ok": false,
        "error": "blackhole_not_installed",
        "duration_seconds_requested": duration,
        "devices": deviceListJson,
        "hint": "BlackHole-2ch is not installed (no input device matched 'BlackHole 2ch'). Install: `brew install blackhole-2ch`. After install you may need to allow the system extension in System Settings → Privacy & Security and reboot. Then create a Multi-Output Device in Audio MIDI Setup.app routing system → speakers + BlackHole, set it as system output, play audio, and re-run."
    ], to: metricsPath)
    exit(7)
}

log("[probe] found BlackHole: id=\(blackhole.id) ch=\(blackhole.inputChannels) sr=\(blackhole.nominalSampleRate)")

// MARK: - TCC authorization probe

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
log("[tcc] mic/audio authorization status: \(authStatusName)")

if authStatus != .authorized {
    log("[error] microphone TCC status is '\(authStatusName)' — capture from BlackHole will not work in headless mode (virtual input shares mic TCC bucket)")
    writeMetrics([
        "ok": false,
        "error": "tcc_not_authorized",
        "tcc_status": authStatusName,
        "duration_seconds_requested": duration,
        "devices": deviceListJson,
        "blackhole_device_id": Int(blackhole.id),
        "hint": "BlackHole is installed, but Microphone permission is not granted to this binary. Virtual audio inputs share the Microphone TCC bucket on macOS 14+. Grant the parent terminal access in System Settings → Privacy & Security → Microphone and re-run."
    ], to: metricsPath)
    exit(6)
}

// MARK: - watchdog

let watchdogSeconds = duration + 10.0
DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + watchdogSeconds) {
    FileHandle.standardError.write("[watchdog] hard timeout after \(watchdogSeconds)s — likely TCC blocked or HAL plug-in stalled\n".data(using: .utf8)!)
    writeMetrics([
        "ok": false,
        "error": "watchdog_timeout",
        "watchdog_seconds": watchdogSeconds,
        "duration_seconds_requested": duration,
        "devices": deviceListJson,
        "blackhole_device_id": Int(blackhole.id),
        "hint": "Engine never returned audio in time. Most common: BlackHole installed but permission not yet propagated, or system output not routed through BlackHole (Multi-Output Device step missed)."
    ], to: metricsPath)
    _exit(5)
}

// MARK: - point AVAudioEngine.inputNode at BlackHole

let engine = AVAudioEngine()
let input = engine.inputNode
log("[boot] AVAudioEngine inputNode acquired; redirecting to BlackHole device id=\(blackhole.id)...")

var blackholeID = blackhole.id
let setStatus = AudioUnitSetProperty(
    input.audioUnit!,
    kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitScope_Global,
    0,
    &blackholeID,
    UInt32(MemoryLayout<AudioDeviceID>.size)
)
if setStatus != noErr {
    log("[error] AudioUnitSetProperty(CurrentDevice) failed: status=\(setStatus)")
    writeMetrics([
        "ok": false,
        "error": "current_device_set_failed",
        "status_code": Int(setStatus),
        "duration_seconds_requested": duration,
        "devices": deviceListJson,
        "blackhole_device_id": Int(blackhole.id),
        "hint": "Could not redirect AVAudioEngine.inputNode to the BlackHole device. Could indicate macOS sandbox restriction or that BlackHole's HAL plug-in failed to load. Re-check `ls /Library/Audio/Plug-Ins/HAL/ | grep -i blackhole` and reboot if unsure."
    ], to: metricsPath)
    exit(9)
}

let inputFormat = input.outputFormat(forBus: 0)
log("[info] effective input format from BlackHole: sampleRate=\(inputFormat.sampleRate) Hz, channels=\(inputFormat.channelCount)")

guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
    log("[error] input format invalid post-redirect (sampleRate=\(inputFormat.sampleRate), channels=\(inputFormat.channelCount))")
    writeMetrics([
        "ok": false,
        "error": "invalid_input_format_post_redirect",
        "sample_rate_hz": inputFormat.sampleRate,
        "channels": Int(inputFormat.channelCount),
        "blackhole_device_id": Int(blackhole.id),
        "devices": deviceListJson
    ], to: metricsPath)
    exit(2)
}

// MARK: - prepare output WAV

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
        "detail": "\(error)",
        "blackhole_device_id": Int(blackhole.id)
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
var maxSamplePeak: Float = 0
var lastSamplePeak: Float = 0

// Dropout: count callbacks where peak < 1e-4 AND that span ≥50 ms,
// but only after the first 1s of recording (engine warm-up may have silence).
var silentSpanSamples: Int64 = 0
var dropoutCount = 0
let silenceThreshold: Float = 1e-4
let dropoutMinSamples = Int64(inputFormat.sampleRate * 0.050) // 50 ms in samples
let warmUpSamples = Int64(inputFormat.sampleRate * 1.0)        // 1s warm-up

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
            FileHandle.standardError.write("[glitch] cb#\(callbackCount): gap=\(gap) samples\n".data(using: .utf8)!)
        }
    }
    lastBufferEndSample = bufferStart + Int64(buffer.frameLength)

    // Peak amplitude (signal-presence + dropout detection)
    var peak: Float = 0
    if let chData = buffer.floatChannelData {
        let frames = Int(buffer.frameLength)
        let chans = Int(buffer.format.channelCount)
        for c in 0..<chans {
            let ptr = chData[c]
            for i in 0..<frames {
                let v = abs(ptr[i])
                if v > peak { peak = v }
            }
        }
    }
    lastSamplePeak = peak
    if peak > maxSamplePeak { maxSamplePeak = peak }

    // Dropout tracking (post-warm-up)
    if sampleCount > warmUpSamples {
        if peak < silenceThreshold {
            silentSpanSamples += Int64(buffer.frameLength)
            if silentSpanSamples >= dropoutMinSamples {
                // count exactly once per silent span by detecting the threshold crossing
                if silentSpanSamples - Int64(buffer.frameLength) < dropoutMinSamples {
                    dropoutCount += 1
                }
            }
        } else {
            silentSpanSamples = 0
        }
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
        "blackhole_device_id": Int(blackhole.id),
        "devices": deviceListJson,
        "hint": "engine.start failed even though BlackHole is present. If error mentions kAudioHardwareIllegalOperationError, revoke + re-grant Microphone permission. If macOS reports the device is in use by another process, quit other audio apps and retry."
    ], to: metricsPath)
    exit(4)
}

log("[info] capturing \(duration)s from BlackHole-2ch → \(wavPath)")
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

// Pass-bar evaluation
let durationOk = abs(approxRecordedSeconds - duration) <= duration * 0.01
let glitchOk = glitchCount == 0
let dropoutOk = dropoutCount == 0
let latencyOk = (Double(firstCallbackNs) / 1_000_000.0) < 500.0
let allNumericChecksPass = durationOk && glitchOk && dropoutOk && latencyOk

let exitCode: Int32 = {
    if !signalPresent { return 8 }   // recorded but silent
    if !allNumericChecksPass { return 10 } // recorded with audio but failed quality bar
    return 0
}()

var metrics: [String: Any] = [
    "ok": callbackCount > 0 && allNumericChecksPass && signalPresent,
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
    "dropout_count": dropoutCount,
    "buffer_size_histogram": histogramJson,
    "write_errors": writeErrors,
    "max_sample_peak": Double(maxSamplePeak),
    "signal_present": signalPresent,
    "output_wav_path": wavPath,
    "blackhole_device_id": Int(blackhole.id),
    "blackhole_device_name": blackhole.name,
    "blackhole_device_uid": blackhole.uid,
    "devices": deviceListJson,
    "checks": [
        "duration_within_1pct": durationOk,
        "glitch_zero": glitchOk,
        "dropout_zero": dropoutOk,
        "first_callback_latency_under_500ms": latencyOk
    ] as [String: Any]
]

if exitCode == 8 {
    metrics["hint"] = "BlackHole capture worked (no glitches, audio device readable) but recorded silence (peak < 0.001). System output is probably not routed through BlackHole. Set system output to a Multi-Output Device that includes BlackHole 2ch in Audio MIDI Setup, play audio (YouTube / system test tone), then re-run."
}

writeMetrics(metrics, to: metricsPath)

if callbackCount == 0 {
    log("[warn] zero callbacks — engine started but no audio frames received. TCC silently blocking is the most common cause.")
}

log("[ok] callbacks=\(callbackCount), samples=\(sampleCount) (~\(String(format: "%.2f", approxRecordedSeconds))s), first-cb-latency=\(String(format: "%.1f", Double(firstCallbackNs) / 1_000_000.0))ms, glitches=\(glitchCount), dropouts=\(dropoutCount), peak=\(String(format: "%.4f", maxSamplePeak)), wav=\(wavPath)")
exit(exitCode)
