/**
 * Parsed components of a `cc://` direct-connect URL.
 *
 * The URL is the inverse of the address a `claude server` prints:
 *   - TCP:  `cc://[token@]host[:port][/path]`  → `serverUrl: http://host[:port][/path]`
 *   - Unix: `cc+unix://[token@]<socket-path>`  → `serverUrl: unix:<socket-path>`
 */
export type ParsedConnectUrl = {
  /** Host portion for TCP connections, or the socket path for unix connections. */
  host: string
  /** Optional port for TCP connections (undefined for unix sockets). */
  port?: number
  /** Whether the URL targets a unix domain socket (`cc+unix://`). */
  isUnix: boolean
  /** Bearer auth token embedded in the URL userinfo, if any. */
  token?: string
  /** Alias of `token` — the name consumers (`createDirectConnectSession`) read. */
  authToken?: string
  /**
   * Fetch-ready base URL: `http://host[:port][/path]` for TCP,
   * `unix:<socket-path>` for unix sockets. Consumed by
   * `createDirectConnectSession` / the REPL connect flow.
   */
  serverUrl: string
}

const CC_TCP_PREFIX = 'cc://'
const CC_UNIX_PREFIX = 'cc+unix://'

/**
 * Parse a Claude Code `cc://` (or `cc+unix://`) connect URL into its
 * components. Pure function — no I/O, no side effects.
 *
 * @throws Error when the URL does not use a recognized `cc` scheme or is
 *   missing its host/socket-path.
 */
export function parseConnectUrl(url: string): ParsedConnectUrl {
  if (url.startsWith(CC_UNIX_PREFIX)) {
    const rest = url.slice(CC_UNIX_PREFIX.length)
    const { userinfo, remainder } = splitUserinfo(rest)
    const socketPath = decodeURIComponent(remainder)
    if (!socketPath) {
      throw new Error(`Invalid connect URL (missing socket path): ${url}`)
    }
    const token = userinfo ? decodeURIComponent(userinfo) : undefined
    return {
      host: socketPath,
      isUnix: true,
      token,
      authToken: token,
      serverUrl: `unix:${socketPath}`,
    }
  }

  if (url.startsWith(CC_TCP_PREFIX)) {
    const rest = url.slice(CC_TCP_PREFIX.length)
    const { userinfo, remainder } = splitUserinfo(rest)

    // Separate authority (host[:port]) from an optional path.
    const slashIdx = remainder.indexOf('/')
    const authority = slashIdx === -1 ? remainder : remainder.slice(0, slashIdx)
    const path = slashIdx === -1 ? '' : remainder.slice(slashIdx)

    const { host, port } = splitHostPort(authority)
    if (!host) {
      throw new Error(`Invalid connect URL (missing host): ${url}`)
    }

    const token = userinfo ? decodeURIComponent(userinfo) : undefined
    const portSuffix = port === undefined ? '' : `:${port}`
    return {
      host,
      port,
      isUnix: false,
      token,
      authToken: token,
      serverUrl: `http://${host}${portSuffix}${path}`,
    }
  }

  throw new Error(`Invalid connect URL scheme (expected cc:// or cc+unix://): ${url}`)
}

/** Split a leading `userinfo@` segment from the rest of the URL body. */
function splitUserinfo(body: string): { userinfo?: string; remainder: string } {
  const atIdx = body.lastIndexOf('@')
  if (atIdx === -1) {
    return { remainder: body }
  }
  return {
    userinfo: body.slice(0, atIdx),
    remainder: body.slice(atIdx + 1),
  }
}

/** Split a `host[:port]` authority, supporting bracketed IPv6 literals. */
function splitHostPort(authority: string): { host: string; port?: number } {
  // Bracketed IPv6: [::1]:8080 or [::1]
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close !== -1) {
      const host = authority.slice(0, close + 1)
      const afterBracket = authority.slice(close + 1)
      if (afterBracket.startsWith(':')) {
        return { host, port: toPort(afterBracket.slice(1)) }
      }
      return { host }
    }
  }

  const colonIdx = authority.lastIndexOf(':')
  if (colonIdx === -1) {
    return { host: authority }
  }
  return {
    host: authority.slice(0, colonIdx),
    port: toPort(authority.slice(colonIdx + 1)),
  }
}

function toPort(raw: string): number | undefined {
  if (!raw) {
    return undefined
  }
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? undefined : n
}
