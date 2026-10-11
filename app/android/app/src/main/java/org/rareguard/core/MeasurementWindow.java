package org.rareguard.core;

/** Bounded operation accounting. Device acknowledgements and Last replies are not samples. */
public final class MeasurementWindow {
    private EfeProtocol.Metric metric;
    private long startedAt, deadline;
    private int matchingSamples;
    public void start(EfeProtocol.Metric metric, long monotonicMs, long durationMs) {
        if (this.metric != null) throw new IllegalStateException("A measurement is already active");
        if (durationMs < 1000 || durationMs > 90000) throw new IllegalArgumentException("Unbounded duration");
        this.metric = metric; startedAt = monotonicMs; deadline = monotonicMs + durationMs;
        matchingSamples = 0;
    }
    public boolean accept(EfeProtocol.Frame frame, long monotonicMs) {
        if (metric == null || monotonicMs < startedAt || monotonicMs >= deadline ||
                frame.metric != metric || !frame.live || frame.values.isEmpty() ||
                frame.values.get(0).value == 0) return false;
        matchingSamples++; return true;
    }
    public int finish() { int n = matchingSamples; metric = null; matchingSamples = 0; return n; }
    public boolean isActive() { return metric != null; }
    public EfeProtocol.Metric metric() { return metric; }
    public long deadline() { return deadline; }
}
