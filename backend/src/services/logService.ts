import {
    logger,
    mapConsoleTransport,
} from 'react-native-logs'
import { lightFormat } from 'date-fns'
import { LogLevel } from './log/logTypes'

let logLevel = LogLevel.INFO

if (process.env.LOG_LEVEL) {
    logLevel = process.env.LOG_LEVEL.toLowerCase() as LogLevel
}

const log = logger.createLogger({
    severity: logLevel,
    levels: {
        trace: 0,
        debug: 1,
        info: 2,
        warn: 3,
        error: 4,
    },
    transport: [mapConsoleTransport],
    transportOptions: {
        mapLevels: {
            trace: 'log',
            debug: 'debug',
            info: 'info',
            warn: 'warn',
            error: 'error',
        },
    },
    dateFormat: (date: Date) => {
        return `${lightFormat(date, 'HH:mm:ss:SSS')} | `
    },
})

export { log }
