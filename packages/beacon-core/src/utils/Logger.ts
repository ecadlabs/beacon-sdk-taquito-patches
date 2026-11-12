import { getDebugEnabled } from '../debug'

export interface LoggerInterface {
  debug(method: string, ...args: unknown[]): void
  log(method: string, ...args: unknown[]): void
  warn(method: string, ...args: unknown[]): void
  error(method: string, ...args: unknown[]): void
  time(start: boolean, label?: string): void
  timeLog(method: string, ...args: unknown[]): void
}

/**
 * The logger that is used internally
 */
export class InternalLogger implements LoggerInterface {
  constructor() {}

  public debug(name: string, method: string, ...args: unknown[]): void {
    this._log('debug', name, method, args)
  }

  public log(name: string, method: string, ...args: unknown[]): void {
    this._log('log', name, method, args)
  }

  public warn(name: string, method: string, ...args: unknown[]): void {
    this._log('warn', name, method, args)
  }

  public error(name: string, method: string, ...args: unknown[]): void {
    this._log('error', name, method, args)
  }

  public time(start: boolean, label?: string | undefined): void {
    start ? console.time(label) : console.timeEnd(label)
  }

  public timeLog(method: string, ...args: unknown[]): void {
    this._log('timeLog', '', method, args)
  }

  private _log(
    type: 'debug' | 'log' | 'warn' | 'error' | 'timeLog',
    name: string,
    method: string,
    args: unknown[] = []
  ): void {
    if (!getDebugEnabled()) {
      return
    }

    let groupText = `[BEACON] ${new Date().toISOString()} [${name}](${method})`
    let data = args
    if (args[0] && typeof args[0] === 'string') {
      groupText += ` ${args[0]}`
      data = args.slice(1)
    }

    switch (type) {
      case 'error':
        console.group(groupText)
        console.error(...data)
        break
      case 'warn':
        console.group(groupText)
        console.warn(...data)
        break
      case 'debug':
        console.groupCollapsed(groupText)
        console.debug(...data)
        break
      case 'timeLog':
        console.group(groupText)
        console.timeLog(method, ...data)
        break
      default:
        console.group(groupText)
        console.log(...data)
    }
    console.groupEnd()

    // echo.group(echo.asWarning(`[BEACON] ${message}`))
    // echo.log(echo.asWarning(`[${this.name}]`), echo.asAlert(`(${method})`), ...args)
    // echo.groupEnd()
  }
}

export class Logger implements LoggerInterface {
  private readonly name: string

  constructor(service: string) {
    this.name = service
  }

  public debug(method: string, ...args: unknown[]): void {
    logger.debug(this.name, method, args)
  }

  public log(method: string, ...args: unknown[]): void {
    logger.log(this.name, method, args)
  }

  public warn(method: string, ...args: unknown[]): void {
    logger.warn(this.name, method, args)
  }

  public error(method: string, ...args: unknown[]): void {
    logger.error(this.name, method, args)
  }

  public time(start: boolean, label?: string | undefined): void {
    logger.time(start, label)
  }

  public timeLog(method: string, ...args: unknown[]): void {
    logger.timeLog(method, args)
  }
}

const loggerWrapper: LoggerInterface = new Logger('')
let logger: LoggerInterface = new InternalLogger()

export const setLogger = (newLogger: LoggerInterface): void => {
  logger = newLogger
}

export const getLogger = (): LoggerInterface => loggerWrapper
