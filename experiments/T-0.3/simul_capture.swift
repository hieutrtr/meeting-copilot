// experimental, not for prod
// T-0.3 — Simultaneous mic + system audio capture spike (UNKNOWN #1 prove).
// Two modes:
//   parallel <duration>                     (default) — 2 AVAudioEngine instances, mic + BlackHole
//   aggregate <duration> <agg-device-name>  — single AVAudioEngine on user-pre-built Aggregate Device
// Measures per-stream (callbacks, latency, glitches, peak) and cross-stream
// (sync_offset_ms, drift_ms_over_60s, cpu_avg_pct, cpu_peak_pct).
// See docs/tasks/phase-0/T-0.3-mic-system-simultaneous.md.

import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox
import Darwin

// MARK: - args

let args = CommandLine.arguments
let mode: String = (args.count > 1) ? args[1] : "parallel"     // "parallel" | "aggregate"
let duration: Double = (args.count > 2) ? (Double(args[2]) ?? 60.0) : 60.0
let aggregateDeviceName: String = (args.count > 3) ? args[3] : "MeetingCopilot Input"

let outDir = "out"
let micWavPath = "\(outDir)/mic.wav"
let sysWavPath = "\(outDir)/system.wav"
let metricsPath = "\(outDir)/metrics.json"
let timeseriesPath = "\(outDir)/timeseries.jsonl"

// MARK: - helpers

func writeMetrics(_ dict: [String: Any], to path: String) {
    do {
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: path))
    } catch {
        FileHandle.standardError.write("[fatal] could not write metrics: \(error)\n".data(using: .utf8)!)
    }
}

func appendTimeseries(_ dict: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
        let line = String(data: data, encoding: .utf8)! + "\n"
        let url = URL(fileURLWithPath: timeseriesPath)
        if FileManager.default.fileExists(atPath: timeseriesPath) {
            let h = try FileHandle(forWritingTo: url)
            try h.seekToEnd()
            h.write(line.data(using: .utf8)!)
            try h.close()
        } else {
            try line.data(using: .utf8)!.write(to: url)
        }
    } catch {
        FileHandle.standardError.write("[warn] timeseries append failed: \(error)\n".data(using: .utf8)!)
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

func tryRemove(_ path: String) {
    try? FileManager.default.removeItem(atPath: path)
}

log("[boot] simul_capture starting (mode=\(mode), duration=\(duration)s)")

// Recreate output dir lazily; trust run.sh has mkdir'd it.
tryRemove(timeseriesPath)
tryRemove(micWavPath)
tryRemove(sysWavPath)

// MARK: - Core Audio device enumeration (reused pattern from T-0.2)

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

func findBlackHole(_ devices: [DeviceInfo]) -> DeviceInfo? {
    return devices.first { d in
        let name = d.name.lowercased()
        let uid = d.uid
        return (name.contains("blackhole 2ch") || name.contains("blackhole2ch") || uid.contains("BlackHole2ch_UID"))
            && d.inputChannels >= 2
    }
}

func findByName(_ devices: [DeviceInfo], _ targetName: String) -> DeviceInfo? {
    let target = targetName.lowercased()
    return devices.first { $0.name.lowercased() == target && $0.inputChannels > 0 }
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

// MARK: - Pre-flight: BlackHole / Aggregate device + TCC

func emitBlocked(_ extra: [String: Any], code: Int32) -> Never {
    var dict: [String: Any] = [
        "ok": false,
        "mode": mode,
        "duration_seconds_requested": duration,
        "devices": deviceListJson
    ]
    for (k, v) in extra { dict[k] = v }
    writeMetrics(dict, to: metricsPath)
    exit(code)
}

if mode == "parallel" {
    guard findBlackHole(inputDevices) != nil else {
        log("[error] BlackHole-2ch not found")
        emitBlocked([
            "error": "blackhole_not_installed",
            "hint": "BlackHole-2ch is not installed. Install: `brew install blackhole-2ch`. Approve system extension in Privacy & Security; reboot if prompted. Create a Multi-Output Device (built-in speakers + BlackHole) in Audio MIDI Setup, set it as system output, play audio, then re-run."
        ], code: 7)
    }
} else if mode == "aggregate" {
    guard findByName(inputDevices, aggregateDeviceName) != nil else {
        log("[error] Aggregate device '\(aggregateDeviceName)' not found among input devices")
        emitBlocked([
            "error": "aggregate_device_not_found",
            "wanted_aggregate_device": aggregateDeviceName,
            "hint": "Open Audio MIDI Setup.app → '+' → 'Create Aggregate Device'. Check 'MacBook Pro Microphone' and 'BlackHole 2ch'. Master = mic. Drift Correction ON for BlackHole. Rename to '\(aggregateDeviceName)'. Re-run."
        ], code: 11)
    }
} else {
    log("[error] unknown mode '\(mode)' (expected 'parallel' or 'aggregate')")
    emitBlocked([
        "error": "unknown_mode",
        "got_mode": mode,
        "hint": "Mode must be 'parallel' or 'aggregate'. Example: ./run.sh 60 parallel  OR  ./run.sh 60 aggregate \"MeetingCopilot Input\"."
    ], code: 2)
}

// TCC pre-flight (covers both modes — virtual inputs share the mic TCC bucket)
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
    log("[error] microphone TCC not authorized; capture will not work in headless mode")
    emitBlocked([
        "error": "tcc_not_authorized",
        "tcc_status": authStatusName,
        "hint": "Microphone permission not granted. Grant the parent terminal Mic access in System Settings → Privacy & Security → Microphone, then re-run from an interactive shell. Virtual inputs (BlackHole, aggregates) share the mic TCC bucket on macOS 14+."
    ], code: 6)
}

// MARK: - Watchdog

let watchdogSeconds = duration + 12.0
DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + watchdogSeconds) {
    FileHandle.standardError.write("[watchdog] hard timeout after \(watchdogSeconds)s — at least one engine wedged\n".data(using: .utf8)!)
    let dict: [String: Any] = [
        "ok": false,
        "mode": mode,
        "error": "watchdog_timeout",
        "watchdog_seconds": watchdogSeconds,
        "duration_seconds_requested": duration,
        "devices": deviceListJson,
        "hint": "Engine never returned audio in time. In parallel mode, this often means BlackHole is installed but no audio is routing through it (check Multi-Output Device + system output). In aggregate mode, check the Aggregate Device's master clock + drift correction settings."
    ]
    writeMetrics(dict, to: metricsPath)
    _exit(5)
}

// MARK: - per-stream tap state

final class StreamMetrics {
    let label: String
    let lock = NSLock()
    var callbackCount = 0
    var sampleCount: Int64 = 0
    var firstCallbackHostTime: UInt64 = 0
    var lastBufferEndSample: Int64 = -1
    var glitchCount = 0
    var totalGapSamples: Int64 = 0
    var bufferSizeHistogram: [UInt32: Int] = [:]
    var writeErrors = 0
    var maxSamplePeak: Float = 0
    var dropoutCount = 0
    var silentSpanSamples: Int64 = 0
    var sampleRate: Double = 0
    var channels: Int = 0
    var audioFile: AVAudioFile?

    init(label: String) { self.label = label }
}

func installTap(engine: AVAudioEngine,
                metrics: StreamMetrics,
                wavPath: String,
                channelSelect: @escaping ((AVAudioPCMBuffer) -> Float)) -> Bool {
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    metrics.sampleRate = inputFormat.sampleRate
    metrics.channels = Int(inputFormat.channelCount)

    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { return false }

    // WAV: write at native float32 format. Phase 1 will resample to 16k mono.
    let wavSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: inputFormat.sampleRate,
        AVNumberOfChannelsKey: inputFormat.channelCount,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]
    do {
        metrics.audioFile = try AVAudioFile(forWriting: URL(fileURLWithPath: wavPath),
                                            settings: wavSettings,
                                            commonFormat: .pcmFormatFloat32,
                                            interleaved: false)
    } catch {
        log("[error] [\(metrics.label)] AVAudioFile open failed: \(error)")
        return false
    }

    let dropoutMinSamples = Int64(inputFormat.sampleRate * 0.050) // 50ms
    let warmUpSamples = Int64(inputFormat.sampleRate * 1.0)        // 1s warm-up
    let silenceThreshold: Float = 1e-4

    input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, time in
        metrics.lock.lock()
        defer { metrics.lock.unlock() }

        if metrics.callbackCount == 0 {
            metrics.firstCallbackHostTime = time.hostTime
        }
        metrics.callbackCount += 1
        metrics.sampleCount += Int64(buffer.frameLength)
        metrics.bufferSizeHistogram[buffer.frameLength, default: 0] += 1

        let bufferStart = time.sampleTime
        if metrics.lastBufferEndSample >= 0 {
            let gap = bufferStart - metrics.lastBufferEndSample
            if gap > 0 {
                metrics.glitchCount += 1
                metrics.totalGapSamples += gap
                FileHandle.standardError.write("[glitch:\(metrics.label)] cb#\(metrics.callbackCount): gap=\(gap) samples\n".data(using: .utf8)!)
            }
        }
        metrics.lastBufferEndSample = bufferStart + Int64(buffer.frameLength)

        let peak = channelSelect(buffer)
        if peak > metrics.maxSamplePeak { metrics.maxSamplePeak = peak }

        if metrics.sampleCount > warmUpSamples {
            if peak < silenceThreshold {
                metrics.silentSpanSamples += Int64(buffer.frameLength)
                if metrics.silentSpanSamples >= dropoutMinSamples,
                   metrics.silentSpanSamples - Int64(buffer.frameLength) < dropoutMinSamples {
                    metrics.dropoutCount += 1
                }
            } else {
                metrics.silentSpanSamples = 0
            }
        }

        do {
            try metrics.audioFile?.write(from: buffer)
        } catch {
            metrics.writeErrors += 1
            FileHandle.standardError.write("[error:\(metrics.label)] write failed: \(error)\n".data(using: .utf8)!)
        }
    }
    return true
}

func peakAllChannels(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let chData = buffer.floatChannelData else { return 0 }
    let frames = Int(buffer.frameLength)
    let chans = Int(buffer.format.channelCount)
    var peak: Float = 0
    for c in 0..<chans {
        let p = chData[c]
        for i in 0..<frames {
            let v = abs(p[i])
            if v > peak { peak = v }
        }
    }
    return peak
}

// MARK: - CPU sampling

struct CPUSnapshot {
    let wallNs: UInt64
    let cpuNs: UInt64   // user + system
    static func now() -> CPUSnapshot {
        var ru = rusage()
        getrusage(RUSAGE_SELF, &ru)
        let user = UInt64(ru.ru_utime.tv_sec) * 1_000_000_000 + UInt64(ru.ru_utime.tv_usec) * 1_000
        let sys  = UInt64(ru.ru_stime.tv_sec) * 1_000_000_000 + UInt64(ru.ru_stime.tv_usec) * 1_000
        return CPUSnapshot(wallNs: mach_absolute_time(), cpuNs: user + sys)
    }
}

// MARK: - mode dispatch

let micMetrics = StreamMetrics(label: "mic")
let sysMetrics = StreamMetrics(label: "sys")

let micEngine: AVAudioEngine
let sysEngine: AVAudioEngine

if mode == "parallel" {
    log("[mode] parallel — 2x AVAudioEngine (default mic + BlackHole-redirected)")

    // engine 1: default mic
    micEngine = AVAudioEngine()

    // engine 2: BlackHole-redirected
    sysEngine = AVAudioEngine()
    let blackhole = findBlackHole(inputDevices)!
    var bhID = blackhole.id
    let inAU = sysEngine.inputNode.audioUnit!
    let setStatus = AudioUnitSetProperty(
        inAU,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &bhID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    if setStatus != noErr {
        log("[error] AudioUnitSetProperty(CurrentDevice → BlackHole) failed: status=\(setStatus)")
        emitBlocked([
            "error": "current_device_set_failed",
            "status_code": Int(setStatus),
            "blackhole_device_id": Int(blackhole.id),
            "hint": "Could not redirect AVAudioEngine.inputNode to BlackHole. Re-check `ls /Library/Audio/Plug-Ins/HAL/ | grep -i blackhole` and reboot if recently installed."
        ], code: 9)
    }
    log("[mode] parallel: sys-engine redirected to BlackHole id=\(blackhole.id)")
} else {
    // aggregate
    log("[mode] aggregate — 1x AVAudioEngine on '\(aggregateDeviceName)' Aggregate Device")
    let agg = findByName(inputDevices, aggregateDeviceName)!
    micEngine = AVAudioEngine()       // alias — single engine drives both taps via channel split
    sysEngine = micEngine
    var aggID = agg.id
    let inAU = micEngine.inputNode.audioUnit!
    let setStatus = AudioUnitSetProperty(
        inAU,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &aggID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    if setStatus != noErr {
        log("[error] AudioUnitSetProperty(CurrentDevice → \(aggregateDeviceName)) failed: status=\(setStatus)")
        emitBlocked([
            "error": "current_device_set_failed",
            "status_code": Int(setStatus),
            "aggregate_device_id": Int(agg.id),
            "hint": "Could not redirect AVAudioEngine.inputNode to the aggregate device. Re-check the device exists in Audio MIDI Setup with at least 2 input channels (mic + BlackHole)."
        ], code: 9)
    }
    log("[mode] aggregate: engine pointed at aggregate id=\(agg.id) ch=\(agg.inputChannels) sr=\(agg.nominalSampleRate)")
}

// MARK: - install taps

if mode == "parallel" {
    guard installTap(engine: micEngine, metrics: micMetrics, wavPath: micWavPath, channelSelect: peakAllChannels) else {
        emitBlocked(["error": "mic_tap_install_failed"], code: 3)
    }
    guard installTap(engine: sysEngine, metrics: sysMetrics, wavPath: sysWavPath, channelSelect: peakAllChannels) else {
        emitBlocked(["error": "sys_tap_install_failed"], code: 3)
    }
} else {
    // aggregate: single engine, single tap, write both channels into one combined WAV at native channel count.
    // Then post-hoc the user can split into mic/system via ffmpeg. For metrics we report per-channel peaks.
    // For simplicity we still write 2 separate WAVs by ducking out individual channels into mono buffers.
    // We hook a tap that splits chan-0 → mic, chan-1+ mixed → sys.
    let input = micEngine.inputNode
    let aggFormat = input.outputFormat(forBus: 0)
    micMetrics.sampleRate = aggFormat.sampleRate
    micMetrics.channels = 1
    sysMetrics.sampleRate = aggFormat.sampleRate
    sysMetrics.channels = 1
    let warmUp = Int64(aggFormat.sampleRate * 1.0)
    let dropoutMin = Int64(aggFormat.sampleRate * 0.050)
    let silenceThreshold: Float = 1e-4

    let monoSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: aggFormat.sampleRate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]
    do {
        micMetrics.audioFile = try AVAudioFile(forWriting: URL(fileURLWithPath: micWavPath),
                                               settings: monoSettings,
                                               commonFormat: .pcmFormatFloat32,
                                               interleaved: false)
        sysMetrics.audioFile = try AVAudioFile(forWriting: URL(fileURLWithPath: sysWavPath),
                                               settings: monoSettings,
                                               commonFormat: .pcmFormatFloat32,
                                               interleaved: false)
    } catch {
        log("[error] aggregate WAV open failed: \(error)")
        emitBlocked(["error": "audio_file_open_failed", "detail": "\(error)"], code: 3)
    }

    input.installTap(onBus: 0, bufferSize: 1024, format: aggFormat) { buffer, time in
        guard let chData = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let chans = Int(buffer.format.channelCount)
        let now = time.hostTime
        if micMetrics.callbackCount == 0 { micMetrics.firstCallbackHostTime = now }
        if sysMetrics.callbackCount == 0 { sysMetrics.firstCallbackHostTime = now }
        micMetrics.callbackCount += 1
        sysMetrics.callbackCount += 1
        micMetrics.sampleCount += Int64(frames)
        sysMetrics.sampleCount += Int64(frames)
        micMetrics.bufferSizeHistogram[buffer.frameLength, default: 0] += 1
        sysMetrics.bufferSizeHistogram[buffer.frameLength, default: 0] += 1

        let bufferStart = time.sampleTime
        for m in [micMetrics, sysMetrics] {
            if m.lastBufferEndSample >= 0 {
                let gap = bufferStart - m.lastBufferEndSample
                if gap > 0 {
                    m.glitchCount += 1
                    m.totalGapSamples += gap
                    FileHandle.standardError.write("[glitch:\(m.label)] cb#\(m.callbackCount): gap=\(gap) samples\n".data(using: .utf8)!)
                }
            }
            m.lastBufferEndSample = bufferStart + Int64(frames)
        }

        // Build mono mic buffer = chan-0
        // Build mono sys buffer = mean(chan-1..chans-1) if chans >= 2 else silence
        let monoFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                    sampleRate: aggFormat.sampleRate,
                                    channels: 1,
                                    interleaved: false)!
        let micBuf = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: AVAudioFrameCount(frames))!
        let sysBuf = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: AVAudioFrameCount(frames))!
        micBuf.frameLength = AVAudioFrameCount(frames)
        sysBuf.frameLength = AVAudioFrameCount(frames)
        var micPeak: Float = 0
        var sysPeak: Float = 0
        let micOut = micBuf.floatChannelData![0]
        let sysOut = sysBuf.floatChannelData![0]
        for i in 0..<frames {
            let mv = chData[0][i]
            micOut[i] = mv
            let amv = abs(mv)
            if amv > micPeak { micPeak = amv }
            if chans >= 2 {
                var sum: Float = 0
                for c in 1..<chans { sum += chData[c][i] }
                let sv = sum / Float(chans - 1)
                sysOut[i] = sv
                let asv = abs(sv)
                if asv > sysPeak { sysPeak = asv }
            } else {
                sysOut[i] = 0
            }
        }
        if micPeak > micMetrics.maxSamplePeak { micMetrics.maxSamplePeak = micPeak }
        if sysPeak > sysMetrics.maxSamplePeak { sysMetrics.maxSamplePeak = sysPeak }

        if micMetrics.sampleCount > warmUp {
            if micPeak < silenceThreshold {
                micMetrics.silentSpanSamples += Int64(frames)
                if micMetrics.silentSpanSamples >= dropoutMin,
                   micMetrics.silentSpanSamples - Int64(frames) < dropoutMin {
                    micMetrics.dropoutCount += 1
                }
            } else { micMetrics.silentSpanSamples = 0 }
        }
        if sysMetrics.sampleCount > warmUp {
            if sysPeak < silenceThreshold {
                sysMetrics.silentSpanSamples += Int64(frames)
                if sysMetrics.silentSpanSamples >= dropoutMin,
                   sysMetrics.silentSpanSamples - Int64(frames) < dropoutMin {
                    sysMetrics.dropoutCount += 1
                }
            } else { sysMetrics.silentSpanSamples = 0 }
        }

        do {
            try micMetrics.audioFile?.write(from: micBuf)
            try sysMetrics.audioFile?.write(from: sysBuf)
        } catch {
            micMetrics.writeErrors += 1
            FileHandle.standardError.write("[error] aggregate write failed: \(error)\n".data(using: .utf8)!)
        }
    }
}

// MARK: - run

let startHostTime = mach_absolute_time()
let startCPU = CPUSnapshot.now()
var prevCPU = startCPU
var cpuPeakPct: Double = 0
var cpuSamples: [Double] = []

do {
    if mode == "parallel" {
        try micEngine.start()
        try sysEngine.start()
    } else {
        try micEngine.start()
    }
} catch {
    log("[error] engine.start failed: \(error)")
    emitBlocked([
        "error": "engine_start_failed",
        "detail": "\(error.localizedDescription)",
        "hint": "engine.start failed. If error mentions 'kAudioHardwareIllegalOperationError' (0x6e6f7065 'nope'), Mic permission may have been revoked between probe and start. Re-grant + re-run."
    ], code: 4)
}

log("[run] capturing \(duration)s in mode=\(mode)")

// Periodic timeseries sampler — every 1s for CPU, every 5s for full snapshot.
let sampleQueue = DispatchQueue(label: "timeseries", qos: .utility)
let endDeadline = Date().addingTimeInterval(duration)
let snapshotEvery: Double = 5.0
var nextSnapshot = Date().addingTimeInterval(snapshotEvery)
let cpuEvery: Double = 1.0
var nextCpuTick = Date().addingTimeInterval(cpuEvery)

while Date() < endDeadline {
    Thread.sleep(forTimeInterval: 0.1)
    let now = Date()
    if now >= nextCpuTick {
        let snap = CPUSnapshot.now()
        let dWall = Double(nsBetween(prevCPU.wallNs, snap.wallNs)) / 1_000_000_000.0
        let dCpu  = Double(snap.cpuNs - prevCPU.cpuNs) / 1_000_000_000.0
        let pct = dWall > 0 ? (dCpu / dWall) * 100.0 : 0
        cpuSamples.append(pct)
        if pct > cpuPeakPct { cpuPeakPct = pct }
        prevCPU = snap
        nextCpuTick = now.addingTimeInterval(cpuEvery)
    }
    if now >= nextSnapshot {
        sampleQueue.async {
            let micS = micMetrics.sampleRate > 0 ? Double(micMetrics.sampleCount) / micMetrics.sampleRate : 0
            let sysS = sysMetrics.sampleRate > 0 ? Double(sysMetrics.sampleCount) / sysMetrics.sampleRate : 0
            let driftMs = (micS - sysS) * 1000.0
            let lastCpu = cpuSamples.last ?? 0
            let elapsed = Double(nsBetween(startHostTime, mach_absolute_time())) / 1_000_000_000.0
            appendTimeseries([
                "t_s": elapsed,
                "mic_audio_s": micS,
                "sys_audio_s": sysS,
                "drift_ms": driftMs,
                "cpu_pct": lastCpu
            ])
        }
        nextSnapshot = now.addingTimeInterval(snapshotEvery)
    }
}

// Tear down
if mode == "parallel" {
    micEngine.inputNode.removeTap(onBus: 0)
    sysEngine.inputNode.removeTap(onBus: 0)
    micEngine.stop()
    sysEngine.stop()
} else {
    micEngine.inputNode.removeTap(onBus: 0)
    micEngine.stop()
}

let endHostTime = mach_absolute_time()
let endCPU = CPUSnapshot.now()
let elapsedNs = nsBetween(startHostTime, endHostTime)
let totalCpuNs = endCPU.cpuNs - startCPU.cpuNs
let cpuAvgPct = elapsedNs > 0 ? Double(totalCpuNs) / Double(elapsedNs) * 100.0 : 0

// MARK: - emit

func streamSummary(_ m: StreamMetrics) -> [String: Any] {
    let recordedS = m.sampleRate > 0 ? Double(m.sampleCount) / m.sampleRate : 0
    let firstCbNs = m.firstCallbackHostTime > startHostTime ? nsBetween(startHostTime, m.firstCallbackHostTime) : 0
    let firstCbMs = Double(firstCbNs) / 1_000_000.0
    let signalPresent = m.maxSamplePeak > 0.001
    let histogram: [String: Int] = Dictionary(uniqueKeysWithValues: m.bufferSizeHistogram.map { (String($0.key), $0.value) })
    return [
        "label": m.label,
        "callback_count": m.callbackCount,
        "sample_count": m.sampleCount,
        "sample_rate_hz": m.sampleRate,
        "channels": m.channels,
        "audio_seconds_recorded": recordedS,
        "first_callback_latency_ms": firstCbMs,
        "first_callback_host_time": Int(m.firstCallbackHostTime),
        "glitch_count": m.glitchCount,
        "total_gap_samples": m.totalGapSamples,
        "dropout_count": m.dropoutCount,
        "buffer_size_histogram": histogram,
        "write_errors": m.writeErrors,
        "max_sample_peak": Double(m.maxSamplePeak),
        "signal_present": signalPresent
    ]
}

let micSummary = streamSummary(micMetrics)
let sysSummary = streamSummary(sysMetrics)

// Cross-stream metrics
let micFirstCbNs = micMetrics.firstCallbackHostTime > startHostTime ? Double(nsBetween(startHostTime, micMetrics.firstCallbackHostTime)) : 0
let sysFirstCbNs = sysMetrics.firstCallbackHostTime > startHostTime ? Double(nsBetween(startHostTime, sysMetrics.firstCallbackHostTime)) : 0
let syncOffsetMs = (micFirstCbNs - sysFirstCbNs) / 1_000_000.0
let micS = micMetrics.sampleRate > 0 ? Double(micMetrics.sampleCount) / micMetrics.sampleRate : 0
let sysS = sysMetrics.sampleRate > 0 ? Double(sysMetrics.sampleCount) / sysMetrics.sampleRate : 0
let driftMs = (micS - sysS) * 1000.0
let driftMsOver60 = duration > 0 ? driftMs * (60.0 / duration) : driftMs

// Pass-bar checks
let micGlitchOk = micMetrics.glitchCount == 0
let sysGlitchOk = sysMetrics.glitchCount == 0
let micLatencyOk = (micFirstCbNs / 1_000_000.0) < 500.0
let sysLatencyOk = (sysFirstCbNs / 1_000_000.0) < 500.0
let syncOk = abs(syncOffsetMs) <= 50.0
let driftOk = abs(driftMsOver60) <= 100.0
let cpuAvgOk = cpuAvgPct <= 10.0
let cpuPeakOk = cpuPeakPct <= 25.0
let micDurationOk = abs(micS - duration) <= duration * 0.01
let sysDurationOk = abs(sysS - duration) <= duration * 0.01
let allOk = micGlitchOk && sysGlitchOk && micLatencyOk && sysLatencyOk && syncOk && driftOk && cpuAvgOk && cpuPeakOk && micDurationOk && sysDurationOk

let micSignalOk = micMetrics.maxSamplePeak > 0.001
let sysSignalOk = sysMetrics.maxSamplePeak > 0.001

let exitCode: Int32 = {
    if !sysSignalOk && micSignalOk { return 8 } // recorded but system silent
    if !allOk { return 10 }
    return 0
}()

let verdict: String = {
    if exitCode == 0 { return "GO" }
    if exitCode == 8 { return "CAVEAT-GO (system stream silent — user-side AMS/MultiOutput misconfig)" }
    if exitCode == 10 { return "CAVEAT-GO (numeric quality bar partial; see checks)" }
    return "UNKNOWN"
}()

var metrics: [String: Any] = [
    "ok": allOk && micSignalOk && sysSignalOk,
    "mode": mode,
    "verdict": verdict,
    "duration_seconds_requested": duration,
    "wallclock_seconds": Double(elapsedNs) / 1_000_000_000.0,
    "mic": micSummary,
    "sys": sysSummary,
    "cross": [
        "sync_offset_ms": syncOffsetMs,
        "drift_ms_over_window": driftMs,
        "drift_ms_over_60s": driftMsOver60,
        "cpu_avg_pct": cpuAvgPct,
        "cpu_peak_pct": cpuPeakPct,
        "cpu_sample_count": cpuSamples.count
    ] as [String: Any],
    "checks": [
        "mic_glitch_zero": micGlitchOk,
        "sys_glitch_zero": sysGlitchOk,
        "mic_first_callback_under_500ms": micLatencyOk,
        "sys_first_callback_under_500ms": sysLatencyOk,
        "sync_offset_under_50ms": syncOk,
        "drift_over_60s_under_100ms": driftOk,
        "cpu_avg_under_10pct": cpuAvgOk,
        "cpu_peak_under_25pct": cpuPeakOk,
        "mic_duration_within_1pct": micDurationOk,
        "sys_duration_within_1pct": sysDurationOk
    ] as [String: Any],
    "exit_code": Int(exitCode),
    "devices": deviceListJson
]

if exitCode == 8 {
    metrics["hint"] = "Mic recorded audio but BlackHole/aggregate system channel was silent. Set system output to a Multi-Output Device that includes BlackHole 2ch in Audio MIDI Setup, then play audio (YouTube / Music / system tone) during the run."
}

writeMetrics(metrics, to: metricsPath)

log("[ok] verdict=\(verdict) mic.cb=\(micMetrics.callbackCount) sys.cb=\(sysMetrics.callbackCount) sync=\(String(format: "%.2f", syncOffsetMs))ms drift60s=\(String(format: "%.2f", driftMsOver60))ms cpu_avg=\(String(format: "%.2f", cpuAvgPct))% cpu_peak=\(String(format: "%.2f", cpuPeakPct))% mic.glitches=\(micMetrics.glitchCount) sys.glitches=\(sysMetrics.glitchCount)")
exit(exitCode)
