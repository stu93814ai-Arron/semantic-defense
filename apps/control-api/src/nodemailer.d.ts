declare module "nodemailer" {
  export type TransportOptions = {
    host?: string;
    port?: number;
    secure?: boolean;
    requireTLS?: boolean;
    ignoreTLS?: boolean;
    auth?: { user: string; pass: string };
    tls?: { servername?: string; ca?: string; minVersion?: string; rejectUnauthorized?: boolean };
    logger?: boolean;
    debug?: boolean;
    proxy?: string;
    connectionTimeout?: number; greetingTimeout?: number; socketTimeout?: number;
  };
  export type Transporter = {
    sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
    close(): void;
  };
  export function createTransport(opts: TransportOptions): Transporter;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
