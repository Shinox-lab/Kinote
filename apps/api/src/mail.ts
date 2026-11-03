import nodemailer from 'nodemailer';

/** One plain-text email. */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends Kinote's emails. Without one (no SMTP_URL) the api sends none, and the
 * features that need email (verification, password reset by email) are off.
 */
export interface Mailer {
  /** The console's public address, for links in emails (no trailing slash). */
  readonly publicUrl: string;
  send(mail: Mail): Promise<void>;
}

/** A Mailer on an SMTP server (SMTP_URL, MAIL_FROM, PUBLIC_URL). */
export function createSmtpMailer(o: { smtpUrl: string; from: string; publicUrl: string }): Mailer {
  const transport = nodemailer.createTransport(o.smtpUrl);
  return {
    publicUrl: o.publicUrl.replace(/\/+$/, ''),
    async send(mail) {
      await transport.sendMail({ from: o.from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

/** A Mailer that keeps what it would have sent (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  constructor(readonly publicUrl = 'https://wiki.example') {}
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  /** The last link in the last email to `to`. */
  lastLink(to: string): string | null {
    const mail = [...this.sent].reverse().find((m) => m.to === to);
    return mail?.text.match(/https?:\/\/\S+/g)?.at(-1) ?? null;
  }
}
