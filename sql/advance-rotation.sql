-- ============================================================
-- Advance Rotation
--
-- Run this when the current period is COMPLETED to open the
-- next period with the next person in rotation order.
--
-- USAGE: Replace the circle_id below and run in SQL Editor.
-- ============================================================

DO $$
DECLARE
    v_circle_id       UUID := 'YOUR_CIRCLE_ID_HERE';  -- Replace

    v_contribution    NUMERIC(12,2);
    v_member_count    INT;
    v_last_period     INT;
    v_last_status     TEXT;
    v_last_order      INT;
    v_next_user       UUID;
    v_next_order      INT;
    v_new_ledger_id   UUID;
BEGIN
    -- Get circle contribution
    SELECT contribution_amount INTO v_contribution
    FROM circles WHERE id = v_circle_id;

    -- Count active members
    SELECT COUNT(*) INTO v_member_count
    FROM memberships
    WHERE circle_id = v_circle_id AND status = 'ACTIVE';

    -- Get last period and its status
    SELECT period_number, status INTO v_last_period, v_last_status
    FROM ledgers
    WHERE circle_id = v_circle_id
    ORDER BY period_number DESC
    LIMIT 1;

    -- GUARD: no existing periods -- use seed-pilot.sql first
    IF v_last_period IS NULL THEN
        RAISE EXCEPTION 'No existing periods found for this circle. Use seed-pilot.sql to create the first period.';
    END IF;

    -- GUARD: refuse to advance if current period isn't done
    IF v_last_status IS NOT NULL AND v_last_status != 'COMPLETED' THEN
        RAISE EXCEPTION 'Current period (%) is still %. Complete it before advancing.', v_last_period, v_last_status;
    END IF;

    -- Get the rotation order of the last recipient
    SELECT m.rotation_order INTO v_last_order
    FROM ledgers l
    JOIN memberships m ON m.user_id = l.recipient_user_id AND m.circle_id = l.circle_id
    WHERE l.circle_id = v_circle_id AND l.period_number = v_last_period;

    -- Find next member in rotation (wrap around)
    SELECT user_id, rotation_order INTO v_next_user, v_next_order
    FROM memberships
    WHERE circle_id = v_circle_id
      AND status = 'ACTIVE'
      AND rotation_order > v_last_order
    ORDER BY rotation_order
    LIMIT 1;

    -- If no one found (we're at the end), wrap to order=1
    IF v_next_user IS NULL THEN
        SELECT user_id, rotation_order INTO v_next_user, v_next_order
        FROM memberships
        WHERE circle_id = v_circle_id AND status = 'ACTIVE'
        ORDER BY rotation_order
        LIMIT 1;
    END IF;

    -- Create new ledger period
    INSERT INTO ledgers (
        circle_id, period_number, recipient_user_id,
        expected_pot, status,
        period_start, period_end
    ) VALUES (
        v_circle_id,
        v_last_period + 1,
        v_next_user,
        v_contribution * (v_member_count - 1),
        'OPEN',
        CURRENT_DATE,
        CURRENT_DATE + INTERVAL '30 days'
    )
    RETURNING id INTO v_new_ledger_id;

    RAISE NOTICE '──────────────────────────────';
    RAISE NOTICE 'Period % opened', v_last_period + 1;
    RAISE NOTICE 'Recipient: % (order #%)', v_next_user, v_next_order;
    RAISE NOTICE 'Expected pot: $%', v_contribution * (v_member_count - 1);
    RAISE NOTICE 'Ledger ID: %', v_new_ledger_id;

END $$;
