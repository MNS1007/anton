#!/usr/bin/env node
// anton-resume <name> [task]: see sessions.js.
process.argv.splice(2, 0, 'resume')
await import('./sessions.js')
