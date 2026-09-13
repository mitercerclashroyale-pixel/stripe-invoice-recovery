require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { Resend } = require('resend');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ==========================================
// 1. STRIPE WEBHOOK HANDLER
// ==========================================
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook Signature Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const dataObject = event.data.object;

    switch (event.type) {
        case 'invoice.created':
        case 'invoice.sent': {
            const invoice = dataObject;
            const query = `
                INSERT INTO invoices (
                    stripe_invoice_id, stripe_account_id, customer_email, 
                    customer_name, amount_due, currency, hosted_invoice_url, due_date, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, TO_TIMESTAMP($8), $9)
                ON CONFLICT (stripe_invoice_id) 
                DO UPDATE SET status = EXCLUDED.status, due_date = EXCLUDED.due_date;
            `;
            const values = [
                invoice.id,
                event.account || 'self',
                invoice.customer_email,
                invoice.customer_name || 'Valued Customer',
                invoice.amount_due,
                invoice.currency,
                invoice.hosted_invoice_url,
                invoice.due_date || (Math.floor(Date.now() / 1000) + 86400 * 7),
                invoice.status
            ];
            await db.query(query, values);
            console.log(`Invoice registered: ${invoice.id}`);
            break;
        }

        case 'invoice.paid':
        case 'invoice.marked_uncollectible': {
            const invoice = dataObject;
            await db.query(
                'UPDATE invoices SET status = $1 WHERE stripe_invoice_id = $2',
                [invoice.status, invoice.id]
            );
            console.log(`Invoice updated to ${invoice.status}: ${invoice.id}`);
            break;
        }

        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
});

app.use(express.json());

// ==========================================
// 2. EMAIL TEMPLATE ENGINE
// ==========================================
function getEmailContent(step, invoice) {
    const formattedAmount = (invoice.amount_due / 100).toFixed(2) + ' ' + invoice.currency.toUpperCase();
    const payUrl = invoice.hosted_invoice_url;
    const name = invoice.customer_name || 'Customer';

    switch (step) {
        case 1:
            return {
                subject: `Quick heads-up: Invoice ${invoice.stripe_invoice_id}`,
                html: `<p>Hi ${name},</p>
                       <p>This is a quick courtesy note to check on your invoice for <strong>${formattedAmount}</strong>.</p>
                       <p>You can view and pay it securely here: <a href="${payUrl}">Pay Invoice Online</a></p>
                       <p>Best regards,<br>Accounts Team</p>`
            };
        case 2:
            return {
                subject: `Overdue Notice: Invoice ${invoice.stripe_invoice_id}`,
                html: `<p>Hi ${name},</p>
                       <p>Your invoice for <strong>${formattedAmount}</strong> is now 7 days past due.</p>
                       <p>Please settle the outstanding balance here to avoid service interruptions: <a href="${payUrl}">Pay Invoice Online</a></p>
                       <p>Thank you,<br>Accounts Team</p>`
            };
        case 3:
            return {
                subject: `ACTION REQUIRED: Invoice ${invoice.stripe_invoice_id} is 14 days overdue`,
                html: `<p>Dear ${name},</p>
                       <p>We have not yet received payment for invoice <strong>${invoice.stripe_invoice_id}</strong> (${formattedAmount}).</p>
                       <p>Please process payment immediately: <a href="${payUrl}">Pay Invoice Instantly</a></p>
                       <p>Sincerely,<br>Accounts Team</p>`
            };
    }
}

// ==========================================
// 3. SCHEDULED CRON WORKER (DAILY AT 09:00 AM)
// ==========================================
cron.schedule('0 9 * * *', async () => {
    console.log('Running daily overdue invoice checker...');

    try {
        const result = await db.query(`
            SELECT *, 
                   EXTRACT(DAY FROM (NOW() - due_date)) as days_overdue
            FROM invoices
            WHERE status = 'open' 
              AND due_date < NOW()
        `);

        for (const invoice of result.rows) {
            const days = Math.floor(invoice.days_overdue);
            let targetStep = 0;

            if (days >= 14) targetStep = 3;
            else if (days >= 7) targetStep = 2;
            else if (days >= 3) targetStep = 1;

            if (targetStep > invoice.last_reminder_step) {
                const mail = getEmailContent(targetStep, invoice);

                await resend.emails.send({
                    from: process.env.FROM_EMAIL,
                    to: invoice.customer_email,
                    subject: mail.subject,
                    html: mail.html
                });

                await db.query(`
                    UPDATE invoices 
                    SET last_reminder_step = $1, last_reminder_sent_at = NOW() 
                    WHERE id = $2
                `, [targetStep, invoice.id]);

                console.log(`Step ${targetStep} reminder sent for invoice ${invoice.stripe_invoice_id}`);
            }
        }
    } catch (err) {
        console.error('Error executing cron worker:', err);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server executing on port ${PORT}`));