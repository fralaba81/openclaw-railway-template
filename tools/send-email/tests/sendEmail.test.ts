import { EmailService, EmailOptions } from '../src/sendEmail';
import nodemailer from 'nodemailer';

jest.mock('nodemailer');

describe('EmailService', () => {
    let emailService: EmailService;

    beforeEach(() => {
        emailService = new EmailService();
    });

    it('should send an email with valid options', async () => {
        const sendMailMock = jest.fn();
        (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail: sendMailMock });

        const options: EmailOptions = {
            to: 'test@example.com',
            subject: 'Test Subject',
            body: 'Test Body'
        };

        await emailService.sendEmail(options);
        expect(sendMailMock).toHaveBeenCalledWith({
            from: process.env.SMTP_FROM,
            to: options.to,
            subject: options.subject,
            text: options.body
        });
    });

    it('should throw an error for invalid email', async () => {
        const options: EmailOptions = {
            to: 'invalid-email',
            subject: 'Test Subject',
            body: 'Test Body'
        };

        await expect(emailService.sendEmail(options)).rejects.toThrow('Invalid email address');
    });

    it('should throw an error if subject is empty', async () => {
        const options: EmailOptions = {
            to: 'test@example.com',
            subject: '',
            body: 'Test Body'
        };

        await expect(emailService.sendEmail(options)).rejects.toThrow('Subject cannot be empty');
    });

    it('should throw an error if body is empty', async () => {
        const options: EmailOptions = {
            to: 'test@example.com',
            subject: 'Test Subject',
            body: ''
        };

        await expect(emailService.sendEmail(options)).rejects.toThrow('Body cannot be empty');
    });
});