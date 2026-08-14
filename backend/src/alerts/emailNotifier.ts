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

/**
 * Subject and body, as pure functions so the rendered text can be asserted
 * without an SMTP server — the body is the part an operator actually reads, and
 * it was previously impossible to check without sending mail.
 */
export function emailSubject(n: Notification): string {
    const prefix = n.resolved ? '[RESOLVED]' : SUBJECT_PREFIX[n.severity]
    // Unlike ntfy's HTTP headers, MIME handles non-ASCII subjects itself, so no
    // transliteration is needed here.
    return `${prefix} ${n.title}`
}

export function emailBody(n: Notification): string {
    // The title leads the body, and is NOT merely repeated from the subject.
    // `detail` is optional — several rules omit it entirely ("LND not synced to
    // graph"), and the two source-failure rules pass it through as undefined
    // whenever the underlying error is null. Those alerts previously arrived
    // with a body of nothing but identifiers, which reads as a delivery fault
    // rather than as the alert it is.
    const lines = [n.title]

    if (n.detail && n.detail !== n.title) {
        lines.push('', n.detail)
    }

    lines.push(
        '',
        `rule:     ${n.ruleId}`,
        `subject:  ${n.dedupeKey}`,
        `severity: ${n.severity}`,
        `state:    ${n.resolved ? 'RESOLVED' : 'FIRING'}`,
        `time:     ${new Date().toISOString()}`,
    )

    if (n.redacted) {
        lines.push('', 'Amounts are redacted on this channel (EMAIL_REDACT_AMOUNTS).', 'Read the figures from the dashboard.')
    }

    lines.push('', '-- Minibits Watchdog')

    return lines.join('\n')
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
        const info = await this.getTransporter().sendMail({
            from: config.email.from,
            to: config.email.to.split(',').map((a) => a.trim()).filter(Boolean),
            subject: emailSubject(n),
            text: emailBody(n),
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
