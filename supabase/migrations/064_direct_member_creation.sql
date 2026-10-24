-- ============================================================
-- 064_direct_member_creation.sql — admin-provisioned member accounts
--
-- Lets an owner/admin attach a freshly created auth user to their
-- account with a given role — no invite link, no email confirmation.
--
-- Why an RPC and not a plain UPDATE
--
--   The signup trigger (017) gives every new auth user a throwaway
--   personal account + an 'owner' profile row. Moving that user into
--   the caller's account means rewriting `profiles.account_id` and
--   `profiles.account_role` — columns the RLS policy (017) and the
--   privilege-column trigger (034) both forbid from the browser. This
--   function is the supervised escape hatch, exactly like the member
--   RPCs in 018: SECURITY DEFINER, self-checks the caller's authority
--   via auth.uid(), and raises the SQLSTATEs the API layer maps to
--   HTTP statuses (42501 → 403, 22023 → 400).
--
-- Error contract
--
--   42501 — forbidden (caller is not admin+, or the target belongs to
--           another account)
--   22023 — bad input (target not found, already a member, role is
--           'owner')
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.add_account_member(
  p_user_id UUID,
  p_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_account_owner UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote a member to owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_target_account_id, v_target_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id = v_caller_account_id THEN
    RAISE EXCEPTION 'User is already a member of this account'
      USING ERRCODE = '22023';
  END IF;

  -- The target must still be sitting in the personal account the
  -- signup trigger created for it — i.e. it was never part of another
  -- team. Anything else means we'd be stealing a user from a
  -- different account.
  IF v_target_account_owner <> p_user_id THEN
    RAISE EXCEPTION 'User already belongs to another account'
      USING ERRCODE = '42501';
  END IF;

  -- Move the profile first, so the cascade-on-delete of the old
  -- account can't take the profile with it.
  UPDATE profiles
  SET account_id = v_caller_account_id,
      account_role = p_role
  WHERE user_id = p_user_id;

  -- Housekeeping: drop the now-empty personal account.
  DELETE FROM accounts WHERE id = v_target_account_id;
END;
$$;

ALTER FUNCTION public.add_account_member(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION add_account_member(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_account_member(UUID, account_role_enum) TO authenticated;
