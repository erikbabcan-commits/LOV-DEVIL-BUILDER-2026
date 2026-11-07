-- Store only the time of verified positive live Pro invoices. Legacy
-- deliveries have no preserved amount evidence and are left unknown.
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS positive_pro_invoice_paid_at TIMESTAMPTZ;
