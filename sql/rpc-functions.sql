-- ============================================================
-- SusuCircle: Supabase-Native RPC Functions (v4)
--
-- These run INSIDE Supabase, called directly from the frontend
-- via supabase.rpc(). No FastAPI backend needed for the pilot.
--
-- SECURITY MODEL:
--   Every RPC validates auth.uid() internally.
--   SECURITY DEFINER is used only to bypass RLS for the
--   atomic operations — auth checks happen first.
--
-- PREREQUISITES:
--   - Tables created (via Alembic migration)
--   - RLS policies applied
-- ============================================================

-- Required for SHA-256 in submit RPC
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ──────────────────────────────────────────────
-- 1. SUBMIT PROOF (transactional)
--    Validates: caller is an active member, not the recipient,
--    ledger is accepting payments, no duplicate.
-- ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS submit_payment_proof_tx CASCADE;

CREATE FUNCTION submit_payment_proof_tx(
    p_ledger_id       UUID,
    p_payment_method  TEXT,
    p_receipt_path    TEXT,
    p_payer_note      TEXT,
    p_metadata        JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID AS $$
DECLARE
    v_caller         UUID := auth.uid();
    v_circle_id      UUID;
    v_recipient      UUID;
    v_amount         NUMERIC(12,2);
    v_currency       TEXT;
    v_status         TEXT;
    v_idem_key       TEXT;
    v_proof_id       UUID;
    v_is_member      BOOLEAN;
BEGIN
    -- Require authentication
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Load ledger + circle in one shot
    SELECT l.circle_id, l.recipient_user_id, l.status,
           c.contribution_amount, c.currency
    INTO v_circle_id, v_recipient, v_status, v_amount, v_currency
    FROM ledgers l
    JOIN circles c ON c.id = l.circle_id
    WHERE l.id = p_ledger_id
    FOR UPDATE OF l;  -- Lock the ledger row

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger not found';
    END IF;

    -- Check ledger status
    IF v_status NOT IN ('OPEN', 'COLLECTING') THEN
        RAISE EXCEPTION 'Ledger is % — not accepting payments', v_status;
    END IF;

    -- Check caller is an active member
    SELECT EXISTS (
        SELECT 1 FROM memberships
        WHERE circle_id = v_circle_id
          AND user_id = v_caller
          AND status = 'ACTIVE'
    ) INTO v_is_member;

    IF NOT v_is_member THEN
        RAISE EXCEPTION 'You are not an active member of this circle';
    END IF;

    -- Cannot pay yourself
    IF v_caller = v_recipient THEN
        RAISE EXCEPTION 'The pot recipient does not pay into their own period';
    END IF;

    -- Idempotency key
    v_idem_key := encode(digest(v_caller::text || ':' || p_ledger_id::text, 'sha256'), 'hex');

    -- Insert (unique constraint on idempotency_key catches duplicates)
    INSERT INTO payment_proofs (
        ledger_id, payer_user_id, recipient_user_id,
        amount, currency, payment_method,
        receipt_storage_path, payer_note,
        idempotency_key, metadata
    ) VALUES (
        p_ledger_id, v_caller, v_recipient,
        v_amount, v_currency, p_payment_method,
        p_receipt_path, p_payer_note,
        v_idem_key, p_metadata
    )
    RETURNING id INTO v_proof_id;

    -- Transition OPEN → COLLECTING
    UPDATE ledgers
    SET status = 'COLLECTING'
    WHERE id = p_ledger_id AND status = 'OPEN';

    RETURN v_proof_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ──────────────────────────────────────────────
-- 2. VERIFY + INCREMENT (atomic)
--    Validates: caller IS the recipient on this proof.
-- ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS verify_payment_proof CASCADE;

CREATE FUNCTION verify_payment_proof(
    p_proof_id       UUID,
    p_recipient_note TEXT DEFAULT NULL
)
RETURNS TABLE(
    new_confirmed_total  NUMERIC,
    ledger_completed     BOOLEAN
) AS $$
DECLARE
    v_caller         UUID := auth.uid();
    v_ledger_id      UUID;
    v_recipient      UUID;
    v_amount         NUMERIC(12,2);
    v_proof_status   TEXT;
    v_expected       NUMERIC;
    v_new_total      NUMERIC;
    v_ledger_status  TEXT;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Lock and load the proof
    SELECT ledger_id, recipient_user_id, amount, status
    INTO v_ledger_id, v_recipient, v_amount, v_proof_status
    FROM payment_proofs
    WHERE id = p_proof_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment proof not found';
    END IF;

    -- Only the recipient can verify
    IF v_caller != v_recipient THEN
        RAISE EXCEPTION 'Only the payment recipient can verify this proof';
    END IF;

    -- Status guard
    IF v_proof_status != 'PENDING' THEN
        RAISE EXCEPTION 'Proof is % — can only verify PENDING proofs', v_proof_status;
    END IF;

    -- Update proof
    UPDATE payment_proofs
    SET status = 'VERIFIED',
        recipient_note = p_recipient_note,
        verified_at = now()
    WHERE id = p_proof_id;

    -- Atomic increment on ledger (locked)
    SELECT confirmed_total, expected_pot, status
    INTO v_new_total, v_expected, v_ledger_status
    FROM ledgers
    WHERE id = v_ledger_id
    FOR UPDATE;

    -- If ledger is already COMPLETED (race: another verify just finished it),
    -- the proof is still verified above — increment total for accuracy but
    -- don't change the status.
    IF v_ledger_status = 'COMPLETED' THEN
        UPDATE ledgers
        SET confirmed_total = confirmed_total + v_amount
        WHERE id = v_ledger_id;

        new_confirmed_total := v_new_total + v_amount;
        ledger_completed := TRUE;
        RETURN NEXT;
        RETURN;
    END IF;

    IF v_ledger_status NOT IN ('OPEN', 'COLLECTING') THEN
        RAISE EXCEPTION 'Ledger is % — cannot increment', v_ledger_status;
    END IF;

    v_new_total := v_new_total + v_amount;

    IF v_new_total >= v_expected THEN
        UPDATE ledgers
        SET confirmed_total = v_new_total, status = 'COMPLETED'
        WHERE id = v_ledger_id;

        new_confirmed_total := v_new_total;
        ledger_completed := TRUE;
    ELSE
        UPDATE ledgers
        SET confirmed_total = v_new_total
        WHERE id = v_ledger_id;

        new_confirmed_total := v_new_total;
        ledger_completed := FALSE;
    END IF;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ──────────────────────────────────────────────
-- 3. DISPUTE PROOF
--    Validates: caller is payer OR recipient.
-- ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS dispute_payment_proof CASCADE;

CREATE FUNCTION dispute_payment_proof(
    p_proof_id  UUID,
    p_reason    TEXT
)
RETURNS VOID AS $$
DECLARE
    v_caller    UUID := auth.uid();
    v_payer     UUID;
    v_recipient UUID;
    v_status    TEXT;
    v_ledger_id UUID;
    v_meta      JSONB;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT payer_user_id, recipient_user_id, status, ledger_id, metadata
    INTO v_payer, v_recipient, v_status, v_ledger_id, v_meta
    FROM payment_proofs
    WHERE id = p_proof_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment proof not found';
    END IF;

    IF v_caller NOT IN (v_payer, v_recipient) THEN
        RAISE EXCEPTION 'Only the payer or recipient can dispute this proof';
    END IF;

    IF v_status = 'DISPUTED' THEN
        RAISE EXCEPTION 'This proof is already disputed';
    END IF;

    UPDATE payment_proofs
    SET status = 'DISPUTED',
        disputed_at = now(),
        metadata = v_meta || jsonb_build_object(
            'dispute_reason', p_reason,
            'disputed_by', v_caller::text
        )
    WHERE id = p_proof_id;

    UPDATE ledgers
    SET status = 'DISPUTED'
    WHERE id = v_ledger_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ──────────────────────────────────────────────
-- 4. STORAGE POLICIES FOR RECEIPTS BUCKET
--    Run AFTER creating the bucket in Dashboard.
-- ──────────────────────────────────────────────

-- Allow authenticated users to upload to their own folder
CREATE POLICY receipts_insert_own ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'receipts'
        AND auth.uid() IS NOT NULL
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Allow authenticated users to read receipts
-- (circle membership enforced at the RPC/app layer via signed URLs)
CREATE POLICY receipts_select_authenticated ON storage.objects
    FOR SELECT
    USING (
        bucket_id = 'receipts'
        AND auth.uid() IS NOT NULL
    );


-- ──────────────────────────────────────────────
-- 5. ENABLE REALTIME on payment_proofs
--    Required for the verify page to auto-refresh
--    when a payer submits a new proof.
--    Idempotent: checks if already added.
-- ──────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND tablename = 'payment_proofs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE payment_proofs;
    END IF;
END $$;
