-- ============================================================
-- PROFILES TABLE
-- Auto-populated from Supabase Auth on signup.
-- Used to resolve display names in the UI.
-- ============================================================

CREATE TABLE IF NOT EXISTS profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT 'Member',
    avatar_url   TEXT,
    created_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read profiles (needed for member roster)
CREATE POLICY profiles_select_authenticated ON profiles
    FOR SELECT USING (auth.uid() IS NOT NULL);

-- Users can only update their own profile
CREATE POLICY profiles_update_own ON profiles
    FOR UPDATE USING (id = auth.uid());

-- Auto-create profile on signup
-- DROP + CREATE (not CREATE OR REPLACE) to fail loud on signature changes
DROP FUNCTION IF EXISTS handle_new_user() CASCADE;

CREATE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, display_name)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'display_name', 'Member')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CASCADE above already dropped the trigger; recreate it
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_user();

-- ── BACKFILL: create profiles for any users who already exist ──
INSERT INTO profiles (id, display_name)
SELECT
    id,
    COALESCE(raw_user_meta_data->>'display_name', 'Member')
FROM auth.users
ON CONFLICT (id) DO NOTHING;
