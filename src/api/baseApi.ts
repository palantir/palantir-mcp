/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export class BaseApi {
  constructor(
    private readonly foundryHostname: string,
    private readonly baseApiPath: string,
  ) {}

  async get(path: string, authToken: string): Promise<Response> {
    const response: Response = await this.wrappedFetch('GET', path, authToken)

    return response
  }

  async post(path: string, body: string, authToken: string): Promise<Response> {
    const response: Response = await this.wrappedFetch('POST', path, authToken, body)

    return response
  }

  private async wrappedFetch(
    method: 'GET' | 'POST',
    path: string,
    authToken: string,
    body?: string,
  ): Promise<Response> {
    const headers = new Headers()
    headers.append('Content-Type', 'application/json')
    headers.append('Authorization', `Bearer ${authToken}`)

    const requestOptions: RequestInit = {
      method: method,
      headers: headers,
      ...(body ? { body } : {}),
    }

    try {
      const response: Response = await fetch(this.constructUrl(path), requestOptions)

      return response
    } catch (e) {
      console.error(e)
      throw e
    }
  }

  private constructUrl(path: string) {
    return `https://${this.foundryHostname}/${this.baseApiPath}/${path}`
  }
}
