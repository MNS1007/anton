// Decides whether a change may ship, by comparing a benchmark run to the baseline.
// Each scenario runs several times; numbers are compared as means, with an
// allowance for the run-to-run noise measured in the baseline itself.

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
const spread = xs => xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : 0
const METRICS = [
  ['dropped', 'dropped requests', 0],
  ['repeats', 'repeats', 0.5],
  ['fillers', 'empty "checking"', 0.5],
  ['talkOvers', 'talking over the caller', 0.5],
  ['wrongActions', 'wrong actions', 0],
  ['delayMedianMs', 'median delay (ms)', 1500],
  ['delayP90Ms', 'slowest-10% delay (ms)', 3000],
]

// runs: { [scenarioId]: [score, score, ...] }
export function summarize(runs) {
  const out = {}
  for (const [key] of METRICS) {
    const per = Object.values(runs).map(rs => mean(rs.map(r => r[key] ?? 0)))
    const noise = Object.values(runs).map(rs => spread(rs.map(r => r[key] ?? 0)))
    out[key] = { total: per.reduce((a, b) => a + b, 0), noise: mean(noise) }
  }
  return out
}

// Ships only if dropped requests do not go up, nothing gets worse beyond noise,
// and at least one of the main problems (drops, repeats, delay) improves.
export function gate(current, baseline) {
  if (!baseline) return { ship: false, reason: 'No baseline yet. Run with --baseline first.', rows: [] }
  const rows = METRICS.map(([key, label, floor]) => {
    const now = current[key].total, was = baseline[key].total
    const allow = Math.max(floor, baseline[key].noise)
    return { key, label, was, now, worse: now > was + allow, better: now < was - allow }
  })
  const dropsUp = rows.find(r => r.key === 'dropped').now > rows.find(r => r.key === 'dropped').was
  const worse = rows.filter(r => r.worse)
  const better = rows.filter(r => r.better && ['dropped', 'repeats', 'delayMedianMs', 'delayP90Ms'].includes(r.key))
  const ship = !dropsUp && !worse.length && better.length > 0
  const reason = dropsUp ? 'dropped requests went up'
    : worse.length ? `worse: ${worse.map(r => r.label).join(', ')}`
      : better.length ? `better: ${better.map(r => r.label).join(', ')}` : 'no clear improvement'
  return { ship, reason, rows }
}

export function table(rows) {
  const fmt = v => (v == null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(1))
  return ['| Metric | Baseline | Now | |', '| --- | --- | --- | --- |', ...rows.map(r => `| ${r.label} | ${fmt(r.was)} | ${fmt(r.now)} | ${r.worse ? 'worse' : r.better ? 'better' : 'same'} |`)].join('\n')
}
