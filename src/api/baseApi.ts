/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { FetchBridge, IHttpEndpointOptions, MediaType } from 'conjure-client'
import { HttpRequestContext } from './httpRequestContext.js'

export class BaseApi {
  private readonly fetchBridge: FetchBridge

  constructor(
    readonly context: HttpRequestContext,
    readonly baseApiPath: string,
    private readonly serviceName: string,
  ) {
    this.fetchBridge = new FetchBridge({
      baseUrl: `https://${context.apiUrl.hostname}/${baseApiPath}`,
      token: () => context.token,
      userAgent: {
        // TODO(acapras);
        productName: 'com.palantir.mcp-server',
        productVersion: '0.2.0',
      },
    })
  }

  async get<T>(endpointPath: string, endpointName: string): Promise<T> {
    return this.call(endpointPath, endpointName, 'GET')
  }

  async post<T>(endpointPath: string, endpointName: string, data: any): Promise<T> {
    return this.call(endpointPath, endpointName, 'POST', data)
  }

  private async call<T>(
    endpointPath: string,
    endpointName: string,
    method: 'GET' | 'POST',
    data = null,
  ): Promise<T> {
    const httpCallData: IHttpEndpointOptions = {
      serviceName: this.serviceName,
      endpointPath,
      endpointName,
      method,
      requestMediaType: MediaType.APPLICATION_JSON,
      responseMediaType: MediaType.APPLICATION_JSON,
      pathArguments: [],
      queryArguments: {},
      data,
    }

    console.debug(`Making ${method} request to ${endpointPath}...`)

    const response = await this.fetchBridge.callEndpoint(httpCallData)

    console.debug(`Received response from ${endpointPath}`, response)

    return response as T
  }
}
