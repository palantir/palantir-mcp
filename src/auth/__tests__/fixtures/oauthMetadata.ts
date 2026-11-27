/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export const oauthMetadata = (host = 'https://example.com') => ({
  issuer: `${host}/multipass`,
  authorization_endpoint: `${host}/discovered/authorize`,
  token_endpoint: `${host}/discovered/token`,
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
})

const transports = new WeakMap<typeof fetch, typeof fetch>()

/** Serve discovery locally so token-exchange assertions can ignore it. */
export function withMetadata(request: typeof fetch): typeof fetch {
  let transport = transports.get(request)
  if (!transport) {
    transport = async (url, options) =>
      String(url).includes('/.well-known/')
        ? new Response(JSON.stringify(oauthMetadata()))
        : request(url, options)
    transports.set(request, transport)
  }
  return transport
}
