/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { TokenProvider } from '../tokenProvider.js'
import { OAuthClient } from './client.js'
import { discardBody } from './response.js'
import { Credential } from './store.js'

/** OAuth acquisition is independent of tool options and every legacy credential source. */
export class OAuthTokenProvider implements TokenProvider {
  constructor(
    private readonly client: OAuthClient,
    private readonly request: typeof fetch = fetch,
    public credential?: Credential,
    private readonly minValidityMs = 60_000,
  ) {}

  async getToken(signal?: AbortSignal): Promise<string> {
    this.credential = await this.client.acquire({ signal, minValidityMs: this.minValidityMs })
    return this.credential.accessToken
  }

  /** Caller authorization is opaque. Only our own bearer token can trigger one 401 retry. */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const target = new URL(input instanceof Request ? input.url : input)
    if (target.origin !== this.client.config.host)
      throw new Error('OAuth request origin does not match credential profile')
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (headers.has('Authorization')) return this.request(input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    const token = this.credential?.accessToken ?? (await this.getToken(signal ?? undefined))
    headers.set('Authorization', `Bearer ${token}`)
    const retryInput = input instanceof Request ? input.clone() : input
    // Standard fetch strips Authorization on cross-origin redirects. Do not change redirect policy.
    const response = await this.request(input, { ...init, headers })
    if (response.status !== 401) return response
    discardBody(response)
    this.credential = await this.client.acquire({
      rejectedAccessToken: token,
      signal: signal ?? undefined,
    })
    headers.set('Authorization', `Bearer ${this.credential.accessToken}`)
    return this.request(retryInput, { ...init, headers })
  }
}
