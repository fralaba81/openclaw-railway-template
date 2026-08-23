import nodemailer from 'nodemailer';

export interface EmailOptions {
    to: string;
    subject: string;
    body: string;
}

export class EmailService {
    private transporter;

    constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    }

    public async sendEmail(options: EmailOptions): Promise<void> {
        this.validateEmailOptions(options);
        await this.transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: options.to,
            subject: options.subject,
            text: options.body
        });
    }

    private validateEmailOptions(options: EmailOptions): void {
        if (!this.isValidEmail(options.to)) {
            throw new Error('Invalid email address');
        }
        if (!options.subject) {
            throw new Error('Subject cannot be empty');
        }
        if (!options.body) {
            throw new Error('Body cannot be empty');
        }
    }

    private isValidEmail(email: string): boolean {
        const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        return re.test(email);
    }
}