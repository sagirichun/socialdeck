"use client";

import React from "react";

/*
  Charts are hand-rolled SVG. The console needs area, line and bar series with exact
  axis labels and no runtime chart dependency; a library would add 40kB for three shapes.
*/

export interface Point {
  x: string;
  y: number;
}

const pad = { l: 40, r: 10, t: 10, b: 22 };

function scale(values: number[], height: number) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  return (v: number) => height - ((v - min) / span) * height;
}

function path(points: Point[], width: number, height: number, smooth = true) {
  const xs = points.map((_, i) => pad.l + (i * (width - pad.l - pad.r)) / Math.max(points.length - 1, 1));
  const sy = scale(
    points.map((p) => p.y),
    height - pad.t - pad.b,
  );
  const ys = points.map((p) => pad.t + sy(p.y));
  if (!points.length) return { line: "", area: "", xs, ys };
  let d = `M ${xs[0]} ${ys[0]}`;
  if (smooth && points.length > 2) {
    for (let i = 1; i < points.length; i++) {
      const cx = (xs[i - 1] + xs[i]) / 2;
      d += ` C ${cx} ${ys[i - 1]}, ${cx} ${ys[i]}, ${xs[i]} ${ys[i]}`;
    }
  } else {
    for (let i = 1; i < points.length; i++) d += ` L ${xs[i]} ${ys[i]}`;
  }
  const area = `${d} L ${xs[xs.length - 1]} ${height - pad.b} L ${xs[0]} ${height - pad.b} Z`;
  return { line: d, area, xs, ys };
}

export function AreaChart({
  series,
  height = 180,
  label,
  format = (v: number) => String(Math.round(v)),
  color = "var(--color-accent)",
}: {
  series: Point[];
  height?: number;
  label?: string;
  format?: (v: number) => string;
  color?: string;
}) {
  const width = 720; // viewBox width; rendered responsively
  if (!series.length) {
    return (
      <div className="grid h-[180px] place-items-center text-[12px] text-ink-faint">No data in this window</div>
    );
  }
  const values = series.map((p) => p.y);
  const { line, area, xs } = path(series, width, height);
  const ys = series.map((p) => p.y);
  const max = Math.max(...ys);
  const min = Math.min(...ys);
  const ticks = 4;

  return (
    <div className="w-full">
      {label ? <p className="mb-1 text-[11px] uppercase tracking-[0.06em] text-ink-faint">{label}</p> : null}
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[180px] w-full" preserveAspectRatio="none" role="img">
        <defs>
          <linearGradient id={`fill-${label ?? "x"}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const y = pad.t + (i * (height - pad.t - pad.b)) / ticks;
          const value = max - (i * (max - min)) / ticks;
          return (
            <g key={i}>
              <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke="var(--color-line)" strokeWidth="1" />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize="9" fill="var(--color-ink-faint)">
                {format(value)}
              </text>
            </g>
          );
        })}
        <path d={area} fill={`url(#fill-${label ?? "x"})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
        {xs.map((x, i) =>
          i % Math.ceil(series.length / 7) === 0 || i === series.length - 1 ? (
            <text key={i} x={x} y={height - 6} textAnchor="middle" fontSize="9" fill="var(--color-ink-faint)">
              {series[i].x.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

export function LineChart({
  series,
  height = 180,
  format = (v: number) => String(Math.round(v)),
  showArea = false,
}: {
  series: { name: string; color: string; points: Point[] }[];
  height?: number;
  format?: (v: number) => string;
  showArea?: boolean;
}) {
  const width = 720;
  const all = series.flatMap((s) => s.points.map((p) => p.y));
  if (!all.length) {
    return <div className="grid h-[180px] place-items-center text-[12px] text-ink-faint">No data in this window</div>;
  }
  const max = Math.max(...all);
  const min = Math.min(...all, 0);
  const ticks = 4;
  const toY = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (height - pad.t - pad.b);
  const toX = (i: number, n: number) => pad.l + (i * (width - pad.l - pad.r)) / Math.max(n - 1, 1);

  return (
    <div className="w-full">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
            <span className="h-1.5 w-3 rounded-full" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[180px] w-full" preserveAspectRatio="none" role="img">
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const y = pad.t + (i * (height - pad.t - pad.b)) / ticks;
          return (
            <g key={i}>
              <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke="var(--color-line)" />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize="9" fill="var(--color-ink-faint)">
                {format(max - (i * (max - min)) / ticks)}
              </text>
            </g>
          );
        })}
        {series.map((s) => {
          const d = s.points
            .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i, s.points.length)} ${toY(p.y)}`)
            .join(" ");
          const area = `${d} L ${toX(s.points.length - 1, s.points.length)} ${height - pad.b} L ${toX(0, s.points.length)} ${height - pad.b} Z`;
          return (
            <g key={s.name}>
              {showArea ? <path d={area} fill={s.color} fillOpacity="0.1" /> : null}
              <path d={d} fill="none" stroke={s.color} strokeWidth="1.75" strokeLinecap="round" />
            </g>
          );
        })}
        {series[0].points.map((p, i) =>
          i % Math.ceil(series[0].points.length / 7) === 0 ? (
            <text key={i} x={toX(i, series[0].points.length)} y={height - 6} textAnchor="middle" fontSize="9" fill="var(--color-ink-faint)">
              {p.x.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

export function BarChart({
  data,
  height = 150,
  format = (v: number) => String(v),
}: {
  data: { label: string; value: number; tone?: string }[];
  height?: number;
  format?: (v: number) => string;
}) {
  if (!data.length) {
    return <div className="grid h-[150px] place-items-center text-[12px] text-ink-faint">No data in this window</div>;
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="w-full">
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d) => (
          <div key={d.label} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="tnum text-[10px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
              {format(d.value)}
            </span>
            <div
              className="w-full rounded-t-[3px] transition-all"
              style={{
                height: `${Math.max(2, (d.value / max) * 100)}%`,
                background: d.tone ?? "var(--color-accent)",
                opacity: 0.85,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2 border-t border-line pt-1.5">
        {data.map((d) => (
          <span key={d.label} className="flex-1 truncate text-center text-[9.5px] text-ink-faint">
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal ranked bars used for platform mix and rule hit counts. */
export function RankBars({
  data,
  format = (v: number) => String(v),
}: {
  data: { label: string; value: number; tone?: string }[];
  format?: (v: number) => string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex flex-col gap-2.5">
      {data.map((d) => (
        <div key={d.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="truncate text-[12px] text-ink-dim">{d.label}</span>
            <span className="tnum text-[11.5px] text-ink-mute">{format(d.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full"
              style={{ width: `${(d.value / max) * 100}%`, background: d.tone ?? "var(--color-accent)" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Compact inline series for stat tiles. */
export function Sparkline({ values, tone = "var(--color-accent)" }: { values: number[]; tone?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const d = values
    .map((v, i) => {
      const x = (i * 100) / (values.length - 1);
      const y = 24 - ((v - min) / (max - min || 1)) * 22;
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 26" className="h-6 w-full" preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" />
    </svg>
  );
}
