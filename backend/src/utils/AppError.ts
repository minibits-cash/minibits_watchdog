import { log } from '../services/logService'

export function isObj(v: unknown): v is object {
    return typeof v === 'object'
}

export enum Err {
    CONNECTION_ERROR = 'CONNECTION_ERROR',
    DATABASE_ERROR = 'DATABASE_ERROR',
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR',
    TIMEOUT_ERROR = 'TIMEOUT_ERROR',
    NOTFOUND_ERROR = 'NOTFOUND_ERROR',
    ALREADY_EXISTS_ERROR = 'ALREADY_EXISTS_ERROR',
    UNAUTHORIZED_ERROR = 'UNAUTHORIZED_ERROR',
    SERVER_ERROR = 'SERVER_ERROR',
    LIMIT_ERROR = 'LIMIT_ERROR',
}

export interface IAppError {
    statusCode: string
    name: Err
    message: string
    params?: any
}

class AppError extends Error {
    public statusCode: number
    public name: Err
    public message: string
    public params?: { statusCode: number; caller?: string; message?: string; [key: string]: any }

    constructor(statusCode: number, name: Err = Err.UNKNOWN_ERROR, message: string, params?: any) {
        super(name)
        this.statusCode = statusCode
        this.name = name
        this.message = message
        this.params = params

        let callerFunctionName = 'unknown'

        if (params && params.caller) {
            callerFunctionName = params.caller
            params.statusCode = statusCode
        }

        log.error(
            `[${callerFunctionName}]`,
            name,
            isObj(message) ? JSON.stringify(message) : message,
            JSON.stringify(params),
        )

        Object.setPrototypeOf(this, new.target.prototype)
    }
}

export default AppError
