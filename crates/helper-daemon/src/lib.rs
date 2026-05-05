// Meeting Copilot helper-daemon — Phase 1 T-1.2 scaffold.
// Single liveness fn for now; meeting state + audio pipeline land in T-1.3..T-1.9.
// Surface stays in-process; out-of-process RPC framing per ARCH §8.2 deferred to Phase 1.x.

pub fn ping() -> &'static str {
    "pong"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}
