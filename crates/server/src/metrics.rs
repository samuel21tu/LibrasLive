//! Métricas de latência em memória (campo `latency_ms` do contrato 6.3).

use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize)]
pub struct LatencySnapshot {
    pub count: usize,
    pub avg_ms: f64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub max_ms: u64,
}

#[derive(Debug, Default)]
pub struct LatencyStats {
    samples: Mutex<Vec<u64>>,
}

impl LatencyStats {
    pub fn record(&self, milliseconds: u64) {
        if let Ok(mut samples) = self.samples.lock() {
            samples.push(milliseconds);
            if samples.len() > 1_000 {
                samples.remove(0);
            }
        }
    }

    pub fn snapshot(&self) -> LatencySnapshot {
        let mut samples = match self.samples.lock() {
            Ok(samples) => samples.clone(),
            Err(_) => return LatencySnapshot::default(),
        };
        if samples.is_empty() {
            return LatencySnapshot::default();
        }
        samples.sort_unstable();
        let count = samples.len();
        let soma: u64 = samples.iter().sum();
        LatencySnapshot {
            count,
            avg_ms: soma as f64 / count as f64,
            p50_ms: samples[count / 2],
            p95_ms: samples[(count * 95 / 100).min(count - 1)],
            max_ms: samples[count - 1],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_are_computed() {
        let stats = LatencyStats::default();
        for value in [10, 20, 30, 40, 100] {
            stats.record(value);
        }
        let snapshot = stats.snapshot();
        assert_eq!(snapshot.count, 5);
        assert_eq!(snapshot.p50_ms, 30);
        assert_eq!(snapshot.p95_ms, 100);
        assert_eq!(snapshot.max_ms, 100);
        assert_eq!(snapshot.avg_ms, 40.0);
    }
}
