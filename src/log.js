export function log(msg) {
  const t = new Date().toLocaleTimeString()
  console.log(`[${t}] ${msg}`)
}
