/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { BaseApi } from './baseApi.js'

export class AuthoringApi extends BaseApi {
  constructor(foundryHost: string) {
    super(foundryHost, 'code/api')
  }

  async retrieveToken(secret: string, authToken: string): Promise<string> {
    const response = await this.post('security/token/retrieve', JSON.stringify(secret), authToken)

    if (response.ok) {
      return response.text()
    }

    throw Error(`Failed to retrieve token: ${response.status} ${response.statusText}`)
  }
}
