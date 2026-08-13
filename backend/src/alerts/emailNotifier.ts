import nodemailer, { Transporter } from 'nodemailer'
import { config } from '../config'
import { log } from '../services/logService'
import { Notification, Notifier } from './notifier'
import type { Severity } from '@prisma/client'

/**
 * SMTP transport.
 *
 * Two properties of email matter for a watchdog and are worth being explicit
 * about, because neither is obvious:
 *
 *  1. **SMTP is encrypted hop-by-hop, not end to end.** The destination mailbox
 *     provider sees plaintext. Where that provider is a third party, set
 *     EMAIL_REDACT_AMOUNTS so alerts carry urgency without the mint's figures.
 *
 *  2. **Delivery success is not the same as being read.** SMTP returns 250
 *     Accepted and the message can still be filed as spam. That is a silent
 *     failure the deadman's switch cannot see, because delivery genuinely
 *     succeeded — which is why email is best paired with a push channel rather
 *     than relied on alone.
 */

const SUBJECT_PREFIX: Record<Severity, string> = {
    CRITICAL: '[CRITICAL]',
    WARNING: '[WARNING]',
    INFO: '[INFO]',
}

export class EmailNotifier implements Notifier {
    readonly name = 'email'

    private transporter: Transporter | undefined

    private getTransporter(): Transporter {
        if (!this.transporter) {
            this.transporter = nodemailer.createTransport({
                host: config.email.host,
                port: config.email.port,
                secure: config.email.secure,
                auth:
                    config.email.user || config.email.pass
                        ? { user: config.email.user, pass: config.email.pass }
                        : undefined,
                // Bounded so a hung SMTP server cannot stall a collector tick.
                connectionTimeout: 10_000,
                greetingTimeout: 10_000,
                socketTimeout: 15_000,
            })
        }
        return this.transporter
    }

    async send(n: Notification): Promise<void> {
        const prefix = n.resolved ? '[RESOLVED]' : SUBJECT_PREFIX[n.severity]

        // Unlike ntfy's HTTP headers, MIME handles non-ASCII subjects itself,
        // so no transliteration is needed here.
        const subject = `${prefix} ${n.title}`

        const text = [
            n.detail ?? '',
            '',
            `rule:     ${n.ruleId}`,
            `subject:  ${n.dedupeKey}`,
            `severity: ${n.severity}`,
            `state:    ${n.resolved ? 'RESOLVED' : 'FIRING'}`,
            `time:     ${new Date().toISOString()}`,
            '',
            '-- Minibits Watchdog',
        ].join('\n')

        const info = await this.getTransporter().sendMail({
            from: config.email.from,
            to: config.email.to.split(',').map((a) => a.trim()).filter(Boolean),
            subject,
            text,
        })

        log.debug('[email] sent', { ruleId: n.ruleId, messageId: info.messageId })
    }

    /** Proves the SMTP path works without sending mail. Used by the test endpoint. */
    async verify(): Promise<void> {
        await this.getTransporter().verify()
    }

    close(): void {
        this.transporter?.close()
        this.transporter = undefined
    }
}
