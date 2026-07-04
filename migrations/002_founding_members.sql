-- 002_founding_members.sql
-- "Founding 50" program: the first 50 approved contractors become founding
-- members. Founding members pay ZERO platform fee on their first completed
-- job, and carry a permanent "Founding Member" badge.
--
-- Run this in the Supabase SQL Editor.

-- Marks a contractor as one of the founding 50. Set once, at first approval.
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS is_founding_member BOOLEAN NOT NULL DEFAULT FALSE;

-- How many of a founding member's completed jobs have had their fee waived so
-- far. Caps the free-jobs perk at 1 without needing to re-scan job history on
-- every fee calculation.
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS founding_free_jobs_used INTEGER NOT NULL DEFAULT 0;

-- Fast lookup of how many founders exist (to enforce the cap of 50).
CREATE INDEX IF NOT EXISTS idx_contractors_founding
  ON contractors (is_founding_member)
  WHERE is_founding_member = TRUE;

-- Records, on each job, whether its fee was waived under the founding perk --
-- so the waiver is auditable and a job can't be double-counted.
ALTER TABLE completed_jobs
  ADD COLUMN IF NOT EXISTS fee_waived_founding BOOLEAN NOT NULL DEFAULT FALSE;
