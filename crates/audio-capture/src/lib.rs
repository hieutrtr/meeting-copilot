// audio-capture — Phase 1 T-1.3 + T-1.4 (Meeting Copilot).
// T-1.3: pluggable AudioSource trait + WAV-fixture impl + cpal mic impl.
// T-1.4: PCM ring buffer + sliding-window chunker (resample + mono mixdown to 16 kHz / 2-s windows).
//
// Public surface re-exports below; module docs live in the per-file rustdoc.

pub mod blackhole;
pub mod chunker;
pub mod mic;
pub mod multi_output;
pub mod ring;
pub mod source;
pub mod wav;

pub use blackhole::{
    detect_blackhole, find_blackhole, find_multi_output_with_blackhole, AggregateInfo,
    BlackHoleStatus, CoreAudioProbe, DeviceInfo, RealCoreAudioProbe,
};
pub use chunker::{Chunker, ChunkerConfig};
pub use mic::CpalMicSource;
pub use multi_output::{
    build_aggregate_dict, create_multi_output, find_existing_multi_out, looks_like_blackhole_uid,
    AggregateDeviceCreator, AudioDeviceID, ConfigureError, DeviceDict, DictValue,
    RealAggregateDeviceCreator, IS_STACKED_AGGREGATE, IS_STACKED_MULTI_OUTPUT, KEY_IS_STACKED,
    KEY_MASTER_SUB_DEVICE, KEY_NAME, KEY_SUB_DEVICE_LIST, KEY_SUB_DEVICE_UID, KEY_UID,
    MEETING_COPILOT_MULTI_OUT_NAME, MEETING_COPILOT_MULTI_OUT_UID,
};
pub use ring::RingBuffer;
pub use source::{AudioError, AudioSource, PcmChunk};
pub use wav::WavFileSource;
