-- Fees & billing: per-term fee structures, per-student-per-term invoices,
-- and payment records (cash, bank transfer, Paystack, waiver).
-- Run after migration 010.

BEGIN;

CREATE TYPE chronixedu_payment_method AS ENUM ('cash', 'bank_transfer', 'paystack', 'waiver');
CREATE TYPE chronixedu_invoice_status AS ENUM ('unpaid', 'partial', 'paid');

CREATE TABLE fee_structures (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID            NOT NULL REFERENCES schools(id),
  class_id        UUID            REFERENCES classes(id),
  term_id         UUID            NOT NULL REFERENCES terms(id),
  component_name  TEXT            NOT NULL,
  amount          NUMERIC(12,2)   NOT NULL CHECK (amount >= 0),
  is_mandatory    BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fee_structures_school        ON fee_structures (school_id);
CREATE INDEX idx_fee_structures_term_class    ON fee_structures (term_id, class_id);

CREATE TABLE fee_invoices (
  id            UUID                       PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     UUID                       NOT NULL REFERENCES schools(id),
  student_id    UUID                       NOT NULL REFERENCES students(id),
  term_id       UUID                       NOT NULL REFERENCES terms(id),
  total_amount  NUMERIC(12,2)              NOT NULL DEFAULT 0,
  amount_paid   NUMERIC(12,2)              NOT NULL DEFAULT 0,
  balance       NUMERIC(12,2)              NOT NULL DEFAULT 0,
  status        chronixedu_invoice_status  NOT NULL DEFAULT 'unpaid',
  created_at    TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ,
  UNIQUE (student_id, term_id)
);

CREATE INDEX idx_fee_invoices_school       ON fee_invoices (school_id);
CREATE INDEX idx_fee_invoices_school_term  ON fee_invoices (school_id, term_id);
CREATE INDEX idx_fee_invoices_student      ON fee_invoices (student_id);

CREATE TABLE payments (
  id                  UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          UUID                        NOT NULL REFERENCES fee_invoices(id),
  school_id           UUID                        NOT NULL REFERENCES schools(id),
  amount              NUMERIC(12,2)               NOT NULL CHECK (amount > 0),
  payment_date        TIMESTAMPTZ                 NOT NULL DEFAULT NOW(),
  method              chronixedu_payment_method   NOT NULL,
  reference           TEXT,
  paystack_reference  TEXT,
  recorded_by         UUID                        REFERENCES users(id),
  created_at          TIMESTAMPTZ                 NOT NULL DEFAULT NOW(),
  UNIQUE (paystack_reference)
);

CREATE INDEX idx_payments_invoice  ON payments (invoice_id);
CREATE INDEX idx_payments_school   ON payments (school_id);

COMMIT;
