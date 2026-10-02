import { describe, it, expect } from "vitest";
import {
  Counter,
  DEFAULT_BUCKETS,
  Histogram,
  MetricsRegistry,
  routeLabel,
} from "../src/observability/metrics.js";

// Phase 15. The registry is arithmetic over a map, so the awkward parts
// — label handling, bucket boundaries, the text format — can be checked
// exactly, without a server.

describe("counters", () => {
  it("counts per label set, not in one lump", () => {
    const counter = new Counter("http_requests_total", "Requests.");
    counter.increment({ method: "GET", status: "200" });
    counter.increment({ method: "GET", status: "200" });
    counter.increment({ method: "GET", status: "404" });
    expect(counter.get({ method: "GET", status: "200" })).toBe(2);
    expect(counter.get({ method: "GET", status: "404" })).toBe(1);
    expect(counter.get({ method: "POST", status: "200" })).toBe(0);
  });

  it("treats label order as meaningless, because it is", () => {
    const counter = new Counter("c", "A counter.");
    counter.increment({ a: "1", b: "2" });
    counter.increment({ b: "2", a: "1" });
    expect(counter.get({ a: "1", b: "2" })).toBe(2);
  });

  it("renders the Prometheus text format, labels sorted and escaped", () => {
    const counter = new Counter("http_requests_total", "Requests handled.");
    counter.increment({ route: '/pay"s', method: "GET" }, 3);
    const text = counter.render();
    expect(text).toContain("# HELP http_requests_total Requests handled.");
    expect(text).toContain("# TYPE http_requests_total counter");
    expect(text).toContain('http_requests_total{method="GET",route="/pay\\"s"} 3');
  });
});

describe("histograms", () => {
  it("puts an observation in every bucket at or above it, the way Prometheus expects", () => {
    const histogram = new Histogram("d", "Durations.", [0.1, 0.5, 1]);
    histogram.observe(0.3);
    const text = histogram.render();
    expect(text).toContain('d_bucket{le="0.1"} 0');
    expect(text).toContain('d_bucket{le="0.5"} 1');
    expect(text).toContain('d_bucket{le="1"} 1');
    expect(text).toContain('d_bucket{le="+Inf"} 1');
    expect(text).toContain("d_sum 0.3");
    expect(text).toContain("d_count 1");
  });

  it("counts an observation past the last bucket in the total but in no bucket", () => {
    const histogram = new Histogram("d", "Durations.", [0.1]);
    histogram.observe(30);
    expect(histogram.render()).toContain('d_bucket{le="0.1"} 0');
    expect(histogram.render()).toContain('d_bucket{le="+Inf"} 1');
    expect(histogram.snapshot()).toEqual({ count: 1, sum: 30 });
  });

  it("has buckets that fit an API, from a few milliseconds to a stall", () => {
    expect(DEFAULT_BUCKETS[0]).toBe(0.005);
    expect(DEFAULT_BUCKETS[DEFAULT_BUCKETS.length - 1]).toBe(10);
    expect([...DEFAULT_BUCKETS]).toEqual([...DEFAULT_BUCKETS].sort((a, b) => a - b));
  });
});

describe("route labels", () => {
  it("uses the route's pattern, never the request's path", () => {
    // The difference matters twice over: an id in a label is unbounded
    // cardinality, and it quietly publishes who paid what.
    expect(routeLabel("/api/v1/payments/:id", "/api/v1/payments/8f3a-not-a-real-id")).toBe(
      "/api/v1/payments/:id"
    );
  });

  it("collapses anything unmatched instead of echoing it", () => {
    expect(routeLabel(undefined, "/api/v1/nope/8f3a")).toBe("unmatched_api");
    expect(routeLabel(undefined, "/wp-admin.php")).toBe("unmatched");
    expect(routeLabel("", "/api/v1/x")).toBe("unmatched_api");
  });
});

describe("the registry as a whole", () => {
  it("renders every metric it holds", () => {
    const registry = new MetricsRegistry();
    registry.requests.increment({ method: "GET", route: "/health", status: "200" });
    registry.duration.observe(0.02, { method: "GET", route: "/health" });
    registry.errors.increment({ route: "/api/v1/payments" });
    const text = registry.render();
    expect(text).toContain("http_requests_total");
    expect(text).toContain("http_request_duration_seconds_bucket");
    expect(text).toContain("http_unhandled_errors_total");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("can be emptied, for a test that wants to count from zero", () => {
    const registry = new MetricsRegistry();
    registry.requests.increment({ route: "/health" });
    registry.reset();
    expect(registry.requests.get({ route: "/health" })).toBe(0);
  });
});
