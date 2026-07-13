-- Migration 20260713000400. Files now live in Cloudflare R2; the legacy pg_cron job only removed
-- Supabase Storage objects before deleting database rows, which could leave
-- R2 objects orphaned. Cleanup is handled by the guarded `purge` Edge Function
-- and the scheduled GitHub Actions workflow instead.

do $$
begin
  perform cron.unschedule('purge-expired-portals');
exception
  when undefined_function or invalid_schema_name then null;
  when others then null; -- job was never installed/already removed
end $$;

drop function if exists purge_expired_portals();
