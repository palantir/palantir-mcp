/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { OAuthConfig, OFFLINE_ACCESS, parseScopes } from './config.js'
import { discoverOAuthMetadata } from './metadata.js'
import { discardBody } from './response.js'
import { Credential, OAuthStore } from './store.js'

export async function openBrowser(url: string): Promise<void> {
  // No shell: the URL is a single argument on every platform.
  const windows = process.platform === 'win32'
  const command = process.platform === 'darwin' ? 'open' : windows ? 'explorer.exe' : 'xdg-open'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: 'ignore', timeout: 10_000, windowsHide: true })
    child.once('error', () => reject(new Error('Could not open OAuth browser')))
    // explorer.exe exits with 1 even after opening the URL, so only a launch failure counts there.
    child.once('exit', (code) =>
      code === 0 || windows ? resolve() : reject(new Error('Could not open OAuth browser')),
    )
  })
}

/**
 * Parse a token-response `scope` into reported operation grants. Omitted means unknown (`null`);
 * an empty string is an explicit empty grant. `offline_access` is never an operation grant.
 */
export function parseGrantedScopes(scope: unknown): string[] | null {
  if (scope === undefined) return null
  if (typeof scope !== 'string') throw new Error('Invalid scope')
  const granted = parseScopes(scope)
  return granted.filter((value) => value !== OFFLINE_ACCESS)
}

class OAuthTokenRejectedError extends Error {}

/** A stored token inside this window is refreshed or replaced; a newly issued token is kept even if shorter. */
export interface AcquireOptions {
  /** The access token a resource server rejected (401); it is never returned again. */
  rejectedAccessToken?: string
  signal?: AbortSignal
}

export const DEFAULT_MIN_VALIDITY_MS = 60_000
const CALLBACK_TIMEOUT_MS = 120_000
const EXCHANGE_TIMEOUT_MS = 15_000

/** OAuth acquisition for startup. No legacy cache, Git token, project broker or FOUNDRY_TOKEN use. */
export class OAuthClient {
  private metadataPromise?: ReturnType<typeof discoverOAuthMetadata>
  constructor(
    readonly config: OAuthConfig,
    readonly store = new OAuthStore(config),
    private readonly browser = openBrowser,
    readonly request: typeof fetch = fetch,
  ) {}

  /** One discovery for this startup. A failure is not reused, so a later attempt can retry. */
  private discover(): ReturnType<typeof discoverOAuthMetadata> {
    return (this.metadataPromise ??= discoverOAuthMetadata(this.config.host, this.request).catch(
      (error: unknown) => {
        this.metadataPromise = undefined
        throw error
      },
    ))
  }

  /**
   * Return a usable access token: stored, then one refresh, then one browser authorization.
   * The lock is held across read/network/write, serializing with the private runtime.
   */
  async acquire(options: AcquireOptions = {}): Promise<Credential> {
    const { signal, rejectedAccessToken } = options
    return this.store.locked(async () => {
      const stored = await this.store.read()
      if (
        stored &&
        stored.accessToken !== rejectedAccessToken &&
        stored.expiresAt > Date.now() + DEFAULT_MIN_VALIDITY_MS
      )
        return stored
      if (stored?.refreshToken) {
        try {
          return await this.refreshLocked(stored, signal)
        } catch (error) {
          if (!(error instanceof OAuthTokenRejectedError) || signal?.aborted) throw error
        }
      } else if (stored) {
        await this.store.remove()
      }
      return this.loginLocked(signal)
    }, signal)
  }

  private async loginLocked(signal?: AbortSignal): Promise<Credential> {
    const verifier = randomBytes(32).toString('base64url')
    const code = await this.authorize(verifier, signal)
    const credential = await this.exchange(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: this.config.redirect,
      },
      signal,
    )
    await this.store.write(credential)
    if (this.config.scopes.includes(OFFLINE_ACCESS) && !credential.refreshToken) {
      console.error(
        'OAuth offline access was requested but not granted (no refresh token); another browser login will be needed when the access token expires.',
      )
    }
    return credential
  }

  private async refreshLocked(previous: Credential, signal?: AbortSignal): Promise<Credential> {
    // Discovery cannot consume a refresh token; keep credentials intact if it fails.
    await this.discover()
    signal?.throwIfAborted()
    // Invalidate before sending: a timeout may mean the server consumed a rotating token.
    // Never replay it automatically after an ambiguous response or failed persistence.
    await this.store.remove()
    const next = await this.exchange(
      { grant_type: 'refresh_token', refresh_token: previous.refreshToken! },
      signal,
    )
    // Only a successful response without a replacement retains the previous refresh token.
    // An omitted refresh scope stays unknown (null): neither requested nor previous scopes are inferred.
    const credential = { ...next, refreshToken: next.refreshToken ?? previous.refreshToken }
    await this.store.write(credential)
    return credential
  }

  private async exchange(
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Credential> {
    const metadata = await this.discover()
    // Explicit composition works on Node 18; AbortSignal.any requires newer Node releases.
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timer = setTimeout(abort, EXCHANGE_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      controller.signal.throwIfAborted()
      const response = await this.request(metadata.token_endpoint, {
        method: 'POST',
        // A 307/308 redirect could forward the code or refresh token in the POST body.
        redirect: 'error',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...parameters, client_id: this.config.clientId }),
      })
      if (!response.ok) {
        discardBody(response)
        if ([400, 401, 403].includes(response.status))
          throw new OAuthTokenRejectedError('OAuth token exchange was rejected')
        throw new Error('OAuth token endpoint unavailable')
      }
      const value = (await response.json()) as Record<string, unknown>
      if (
        !value ||
        typeof value.access_token !== 'string' ||
        !value.access_token ||
        typeof value.token_type !== 'string' ||
        value.token_type.toLowerCase() !== 'bearer' ||
        typeof value.expires_in !== 'number' ||
        value.expires_in <= 0 ||
        !Number.isFinite(value.expires_in) ||
        (value.refresh_token !== undefined &&
          (typeof value.refresh_token !== 'string' || !value.refresh_token))
      )
        throw new Error('Invalid response')
      // Reduced grants are valid: requested optional scopes may be omitted by admin policy.
      const grantedScopes = parseGrantedScopes(value.scope)
      const expiresAt = Date.now() + value.expires_in * 1000
      if (!Number.isFinite(expiresAt)) throw new Error('Invalid expiry')
      return {
        version: 1,
        binding: this.store.binding,
        accessToken: value.access_token,
        ...(value.refresh_token === undefined
          ? {}
          : { refreshToken: value.refresh_token as string }),
        expiresAt,
        requestedScopes: this.store.requestedScopes,
        grantedScopes,
      }
    } catch (error) {
      if (error instanceof OAuthTokenRejectedError) throw error
      throw new Error(
        'OAuth exchange failed or was cancelled; verify client installation, scopes and connectivity',
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private async authorize(verifier: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const metadata = await this.discover()
    signal?.throwIfAborted()
    const callback = new URL(this.config.redirect)
    const state = randomBytes(32).toString('base64url')
    let accept!: (code: string) => void
    let reject!: (error: Error) => void
    const result = new Promise<string>((resolve, fail) => {
      accept = resolve
      reject = fail
    })
    // Rejection may precede listener readiness; the same result is awaited below, not ignored.
    void result.catch(() => {})
    const fail = () =>
      reject(new Error('OAuth authorization denied, invalid, cancelled or timed out'))
    let consumed = false
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Security-Policy', "default-src 'none'")
      let url: URL
      try {
        url = new URL(req.url ?? '/', callback.origin)
      } catch {
        res.writeHead(400).end()
        return
      }
      if (
        req.method !== 'GET' ||
        req.headers.host !== callback.host ||
        req.url?.split('?')[0] !== callback.pathname ||
        url.origin !== callback.origin ||
        consumed
      ) {
        res.writeHead(404).end()
        return
      }
      const returnedState = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code')
      const validState =
        url.searchParams.getAll('state').length === 1 &&
        Buffer.byteLength(returnedState) === Buffer.byteLength(state) &&
        timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))
      consumed = true
      if (
        !validState ||
        !code ||
        url.searchParams.getAll('code').length !== 1 ||
        url.searchParams.has('error') ||
        url.hash
      ) {
        res.writeHead(400).end('Authorization failed. Return to the terminal.')
        fail()
        return
      }
      res.end('Authorization received. Return to the terminal.')
      accept(code)
    })
    server.requestTimeout = 5_000
    server.headersTimeout = 5_000
    const timer = setTimeout(fail, CALLBACK_TIMEOUT_MS)
    signal?.addEventListener('abort', fail, { once: true })
    try {
      await new Promise<void>((resolve, failListen) => {
        server.once('error', () => failListen(new Error('OAuth callback port unavailable')))
        server.listen(Number(callback.port), '127.0.0.1', resolve)
      })
      signal?.throwIfAborted()
      const url = new URL(metadata.authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: this.config.clientId,
        redirect_uri: callback.href,
        scope: this.config.scopes.join(' '),
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString()
      console.error('Opening OAuth consent. Check the host and application before approving.')
      await Promise.race([this.browser(url.href), result.then(() => undefined)])
      return await result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', fail)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}
