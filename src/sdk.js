// The Agent SDK. Everything in Anton that runs Claude goes through here, so tests
// can swap in a stand-in: ANTON_TEST_SDK names a module that exports query (and
// optionally listSessions and getSessionInfo), or setSdk swaps one in directly.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import * as real from '@anthropic-ai/claude-agent-sdk'

let impl = real
if (process.env.ANTON_TEST_SDK) impl = { ...real, ...await import(pathToFileURL(resolve(process.env.ANTON_TEST_SDK)).href) }

export function setSdk(stub) { impl = { ...real, ...stub } }
export const query = (...a) => impl.query(...a)
export const listSessions = (...a) => impl.listSessions(...a)
export const getSessionInfo = (...a) => impl.getSessionInfo(...a)
