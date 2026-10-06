import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client';
import { sentEmails } from '../db/schema';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  template?: string;
}

/**
 * Sends email via SMTP when SMTP_URL is configured. Every message is also recorded in
 * `sent_emails` so the dev panel can show verification/reset links without a real inbox.
 */
export class Mailer {
  private readonly transport: Transporter | undefined;

  constructor(
    private readonly db: Db,
    private readonly from: string,
    private readonly log: FastifyBaseLogger,
    smtpUrl?: string,
  ) {
    this.transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : undefined;
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.transport) {
      await this.transport.sendMail({ from: this.from, ...message });
    } else {
      this.log.info({ to: message.to, subject: message.subject }, `📧 ${message.text}`);
    }
    await this.db.insert(sentEmails).values(message);
  }
}
