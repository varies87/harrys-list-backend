-- ===========================================================================
-- Harry's List — security hardening migration
-- Run once in the Supabase SQL editor (Dashboard → SQL) or via the Supabase CLI.
-- Safe to re-run: everything uses IF NOT EXISTS / CREATE OR REPLACE.
-- ===========================================================================

-- 1) Durable rate-limit store -----------------------------------------------
-- Used by api/_shared.js rateLimit() for public writes and the admin-login
-- throttle. If this table is absent the limiter still works but falls back to
-- per-instance in-memory counters that reset on serverless cold starts, so
-- creating it makes throttling durable and consistent across instances.
create table if not exists public.rate_limits (
  id         bigint generated always as identity primary key,
  bucket     text        not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limits_bucket_created_idx
  on public.rate_limits (bucket, created_at);

-- The backend uses the service-role key (SUPABASE_SECRET_KEY), which bypasses
-- RLS, so no policies are required here. Old rows are never read after their
-- window passes; clean them up periodically to keep the table small, e.g.:
--   delete from public.rate_limits where created_at < now() - interval '1 day';
-- (Schedule with pg_cron if available, or run manually now and then.)

-- 2) Atomic thumbs-up counter -----------------------------------------------
-- Replaces the old read-then-write counter in api/reviews.js, which could lose
-- concurrent updates (L-6). reviews.js calls this RPC and only falls back to
-- the non-atomic path if the function is missing.
create or replace function public.increment_thumbs_up(p_contractor_id bigint, p_delta int)
returns void
language sql
as $$
  update public.contractors
     set thumbs_up_count = greatest(0, coalesce(thumbs_up_count, 0) + p_delta)
   where id = p_contractor_id;
$$;
