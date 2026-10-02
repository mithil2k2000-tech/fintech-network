// A small metrics registry (Phase 15, spec §24 Observability).
//
// Hand-rolled rather than pulled in, for two reasons. It's about eighty
// lines, and the Prometheus text format is a stable, documented thing —
// a dependency here would be larger than what it replaces. And writing
// it makes one distinction explicit that a library would hide:
//
//   * What's counted HERE is traffic: requests, durations, statuses.
//     It lives in this process, resets when the process does, and is
//     per-instance. That's fine — nobody balances books with it.
//   * What's counted in the DATABASE is money and decisions: payments,
//     cashback, risk outcomes. Those are never counted here, because a
//     counter that resets is a lie about a ledger. They're read live
//     from the tables that own them (see modules/admin).
//
// Everything here is pure arithmetic over a map, so it can be tested
// without a server.

export type Labels = Record<string, string>;

/**
 * Buckets in seconds. Chosen for an API where anything over a second is
 * already a complaint, with a long tail so a stall is still visible.
 */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join(",");
}

function renderLabels(labels: Labels): string {
  const entries = Object.keys(labels)
    .sort()
    .map((name) => `${name}="${escapeLabelValue(labels[name])}"`);
  return entries.length > 0 ? `{${entries.join(",")}}` : "";
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

interface CounterSeries {
  labels: Labels;
  value: number;
}

interface HistogramSeries {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

export class Counter {
  private readonly series = new Map<string, CounterSeries>();

  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  increment(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) existing.value += by;
    else this.series.set(key, { labels, value: by });
  }

  get(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    for (const [i, bound] of this.buckets.entries()) {
      if (value <= bound) entry.counts[i] += 1;
    }
    entry.sum += value;
    entry.count += 1;
  }

  snapshot(labels: Labels = {}): { count: number; sum: number } {
    const entry = this.series.get(labelKey(labels));
    return { count: entry?.count ?? 0, sum: entry?.sum ?? 0 };
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      for (const [i, bound] of this.buckets.entries()) {
        lines.push(
          `${this.name}_bucket${renderLabels({ ...entry.labels, le: String(bound) })} ${entry.counts[i]}`
        );
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...entry.labels, le: "+Inf" })} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  readonly requests = new Counter(
    "http_requests_total",
    "Requests handled, by method, route and status."
  );
  readonly duration = new Histogram(
    "http_request_duration_seconds",
    "How long requests took, by method and route."
  );
  readonly errors = new Counter(
    "http_unhandled_errors_total",
    "Requests that ended in an unhandled error."
  );

  render(): string {
    return [this.requests.render(), this.duration.render(), this.errors.render()].join("\n") + "\n";
  }

  reset(): void {
    for (const metric of [this.requests, this.errors]) {
      // Counters are rebuilt by dropping their series; the objects
      // themselves stay, so anything holding a reference still works.
      (metric as unknown as { series: Map<string, unknown> }).series.clear();
    }
    (this.duration as unknown as { series: Map<string, unknown> }).series.clear();
  }
}

/**
 * A route label with no identifiers in it. `/api/v1/payments/:id` is a
 * useful label; `/api/v1/payments/8f3a…` is a cardinality bomb and a
 * quiet way of publishing who paid what — so unmatched paths collapse
 * to "unmatched" rather than being echoed into a metric.
 */
export function routeLabel(routerPath: string | undefined, url: string): string {
  if (routerPath && routerPath.length > 0) return routerPath;
  // Fastify sets no route for a 404. Keep the shape, drop the values.
  return url.startsWith("/api/") ? "unmatched_api" : "unmatched";
}
