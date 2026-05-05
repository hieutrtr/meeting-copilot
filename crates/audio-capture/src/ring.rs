// RingBuffer — bounded f32 PCM ring buffer with drop-oldest policy.
// Per T-1.4 task plan §"Goal" + §"AC-2".
//
// Design: single-threaded SPSC use only (push side == drain side run on the same worker thread
// per the chunker's push/pull model). VecDeque is sufficient; lock-free `ringbuf` crate is a
// Phase 1.x micro-optimization gated on T-1.6 changing the threading model.

use std::collections::VecDeque;

/// Bounded ring buffer of `f32` PCM samples with drop-oldest overflow.
///
/// `push_slice` returns the count of samples evicted from the front when the new push would
/// exceed `capacity`. T-1.6's Tauri event bridge surfaces non-zero drop counts as a
/// `meeting:dropped_samples` warning to the UI.
pub struct RingBuffer {
    buf: VecDeque<f32>,
    capacity: usize,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Append samples to the back. If the new total would exceed `capacity`, evict that many
    /// samples from the front (drop-oldest) before pushing. Returns the number of samples
    /// dropped (0 in the steady state).
    pub fn push_slice(&mut self, samples: &[f32]) -> usize {
        // Special-case: a single push larger than capacity keeps only the tail of the input.
        if samples.len() >= self.capacity {
            let dropped_from_buf = self.buf.len();
            let skipped_from_input = samples.len() - self.capacity;
            self.buf.clear();
            self.buf.extend(samples[skipped_from_input..].iter().copied());
            return dropped_from_buf + skipped_from_input;
        }

        let want = self.buf.len() + samples.len();
        let dropped = if want > self.capacity {
            let n = want - self.capacity;
            // VecDeque::drain on the front in O(n).
            self.buf.drain(..n).count()
        } else {
            0
        };
        self.buf.extend(samples.iter().copied());
        dropped
    }

    /// Drain exactly `n` samples from the front. Returns `None` if `len() < n` so callers can
    /// poll without prematurely consuming a partial window.
    pub fn drain(&mut self, n: usize) -> Option<Vec<f32>> {
        if self.buf.len() < n {
            return None;
        }
        Some(self.buf.drain(..n).collect())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_push_within_capacity_no_drop() {
        let mut rb = RingBuffer::new(8);
        let dropped = rb.push_slice(&[0.0, 0.1, 0.2, 0.3, 0.4]);
        assert_eq!(dropped, 0);
        assert_eq!(rb.len(), 5);
        assert!(!rb.is_empty());
        assert_eq!(rb.capacity(), 8);
    }

    #[test]
    fn ring_buffer_push_overflow_drops_oldest() {
        let mut rb = RingBuffer::new(4);
        // First push: fills 3 of 4.
        let d1 = rb.push_slice(&[1.0, 2.0, 3.0]);
        assert_eq!(d1, 0);
        assert_eq!(rb.len(), 3);
        // Second push: 3 + 4 = 7, capacity 4 → must drop 3 oldest.
        // Oldest 3 = [1.0, 2.0, 3.0] — all evicted; new buffer = [10, 20, 30, 40].
        let d2 = rb.push_slice(&[10.0, 20.0, 30.0, 40.0]);
        assert_eq!(d2, 3);
        assert_eq!(rb.len(), 4);
        // Drain to verify FIFO order (head == 10.0).
        let drained = rb.drain(4).expect("drain");
        assert_eq!(drained, vec![10.0, 20.0, 30.0, 40.0]);
    }

    #[test]
    fn ring_buffer_drain_n_returns_none_when_too_few() {
        let mut rb = RingBuffer::new(8);
        rb.push_slice(&[1.0, 2.0, 3.0]);
        assert!(rb.drain(5).is_none());
        // Buffer untouched when drain fails.
        assert_eq!(rb.len(), 3);
    }

    #[test]
    fn ring_buffer_drain_n_extracts_exact_count() {
        let mut rb = RingBuffer::new(8);
        let ramp: Vec<f32> = (0..8).map(|i| i as f32).collect();
        rb.push_slice(&ramp);
        assert_eq!(rb.len(), 8);
        let drained = rb.drain(5).expect("drain");
        assert_eq!(drained, vec![0.0, 1.0, 2.0, 3.0, 4.0]);
        assert_eq!(rb.len(), 3);
        // Tail (5..8) preserved in order.
        let rest = rb.drain(3).expect("rest");
        assert_eq!(rest, vec![5.0, 6.0, 7.0]);
        assert!(rb.is_empty());
    }

    #[test]
    fn ring_buffer_single_push_larger_than_capacity_keeps_tail() {
        // Edge case: one push larger than capacity. Drop policy keeps the latest `capacity` samples.
        let mut rb = RingBuffer::new(3);
        let dropped = rb.push_slice(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(rb.len(), 3);
        assert_eq!(dropped, 2); // 0 from buf (was empty) + 2 skipped from input head
        let drained = rb.drain(3).expect("drain");
        assert_eq!(drained, vec![3.0, 4.0, 5.0]);
    }
}
