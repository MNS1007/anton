// Takes private details out of call text before it becomes a test scenario.
// Regexes catch the shapes (emails, phone numbers, links, money); `terms` are the
// names a model or a person flagged (other people, customer companies, places).
// The owner's own name stays, so scenarios still sound like real calls.

const RULES = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]'],
  [/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[link]'],
  [/(\+?\d[\d\s().-]{7,}\d)/g, '[phone]'],
  [/\$\s?\d[\d,.]*\s?(k|m|b|million|billion|thousand)?\b/gi, '[amount]'],
  [/\b\d[\d,.]*\s?(dollars|usd)\b/gi, '[amount]'],
  [/\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|blvd|lane|ln|drive|dr)\b/gi, '[address]'],
]

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function sanitize(text, { terms = [], keep = [] } = {}) {
  let out = String(text || '')
  for (const [re, ph] of RULES) out = out.replace(re, ph)
  const kept = new Set(keep.map(k => k.toLowerCase()))
  for (const t of [...new Set(terms)].filter(t => t && t.length > 1 && !kept.has(t.toLowerCase())).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b${esc(t)}\\b`, 'gi'), '[name]')
  }
  return out
}
