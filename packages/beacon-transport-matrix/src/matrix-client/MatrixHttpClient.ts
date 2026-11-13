import { Logger } from '@ecadlabs/beacon-core'
import { MatrixRequest, MatrixRequestParams } from './models/api/MatrixRequest'

const logger = new Logger('MatrixHttpClient')

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000

export interface HttpOptions {
  accessToken?: string
  timeoutMs?: number
  signal?: AbortSignal
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

const CLIENT_API_R0 = '/_matrix/client/r0'

/**
 * Handling the HTTP connection to the matrix synapse node
 */
export class MatrixHttpClient {
  private abortController: AbortController

  constructor(private readonly baseUrl: string) {
    this.abortController = new AbortController()
  }

  /**
   * Get data from the synapse node
   */
  public async get<T>(
    endpoint: string,
    params?: MatrixRequestParams<T>,
    options?: HttpOptions
  ): Promise<T> {
    return this.send('GET', endpoint, options, params)
  }

  /**
   * Post data to the synapse node
   */
  public async post<T>(
    endpoint: string,
    body: MatrixRequest<T>,
    options?: HttpOptions,
    params?: MatrixRequestParams<T>
  ): Promise<T> {
    return this.send('POST', endpoint, options, params, body)
  }

  /**
   * Put data to the synapse node
   */
  public async put<T>(
    endpoint: string,
    body: MatrixRequest<T>,
    options?: HttpOptions,
    params?: MatrixRequestParams<T>
  ): Promise<T> {
    return this.send('PUT', endpoint, options, params, body)
  }

  public async cancelAllRequests(): Promise<void> {
    this.abortController.abort()
    this.abortController = new AbortController()
  }

  /**
   * Send a request to the synapse node
   */
  private async send<T>(
    method: HttpMethod,
    endpoint: string,
    config?: HttpOptions,
    requestParams?: MatrixRequestParams<T>,
    data?: MatrixRequest<T>
  ): Promise<T> {
    const headers: Record<string, string> = {}
    if (data !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (config?.accessToken) {
      headers.Authorization = `Bearer ${config.accessToken}`
    }

    const url = this.buildUrl(this.apiUrl(CLIENT_API_R0), endpoint, requestParams)
    const clientAbortSignal = this.abortController.signal
    const requestAbortController = new AbortController()
    const signal = AbortSignal.any(
      config?.signal
        ? [clientAbortSignal, requestAbortController.signal, config.signal]
        : [clientAbortSignal, requestAbortController.signal]
    )
    const timeoutMs = config?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
    const timeoutTimer = setTimeout(() => {
      requestAbortController.abort(new DOMException('Matrix request timed out', 'AbortError'))
    }, timeoutMs)
    signal.addEventListener('abort', () => clearTimeout(timeoutTimer), { once: true })

    try {
      let response: Response
      try {
        response = await fetch(url, {
          method,
          headers,
          body: data !== undefined ? JSON.stringify(data) : undefined,
          signal
        })
      } catch (error) {
        if (!config?.signal?.aborted && !clientAbortSignal.aborted) {
          logger.error('send', (error as Error).name, (error as Error).message)
        }
        throw error
      }

      const payload = await this.parseBody<T>(response)

      if (!response.ok) {
        logger.error('send', String(response.status), response.statusText, payload)
        throw payload
      }

      return payload
    } finally {
      clearTimeout(timeoutTimer)
    }
  }

  private async parseBody<T>(response: Response): Promise<T> {
    const text = await response.text()
    if (!text) {
      return undefined as unknown as T
    }
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  private buildUrl(base: string, endpoint: string, params?: object): string {
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
    let url = `${base}${path}`
    if (params) {
      const search = new URLSearchParams()
      Object.entries(params).forEach(([key, value]: [string, unknown]) => {
        if (value !== undefined) {
          search.append(key, String(value))
        }
      })

      const query = search.toString()
      if (query) {
        url += `?${query}`
      }
    }

    return url
  }

  /**
   * Construct API URL
   */
  private apiUrl(...parts: string[]): string {
    const apiBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl

    const apiParts = parts.map((path) => (path.startsWith('/') ? path.slice(1) : path))

    return [apiBase, ...apiParts].join('/')
  }
}
