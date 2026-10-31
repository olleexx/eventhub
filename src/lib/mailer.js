import nodemailer from 'nodemailer';
import { config } from '../config/env.js';
import { log } from './logger.js';

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.SMTP_HOST) {
    if (config.isProd) throw new Error('SMTP_HOST is not configured');
    // Development/test: print messages instead of sending.
    transporter = nodemailer.createTransport({ jsonTransport: true });
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    pool: true,
    maxConnections: 3,
  });
  return transporter;
}

export async function sendMail({ to, subject, html, text, attachments }) {
  const info = await getTransporter().sendMail({ from: config.SMTP_FROM, to, subject, html, text, attachments });
  if (!config.SMTP_HOST) log.info('mail_dev_output', { to, subject });
  return info;
}

export async function verifyMailer() {
  return getTransporter().verify();
}
