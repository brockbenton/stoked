-- Supabase can create new tables with no API privileges, so grant the server's
-- role exactly what it uses. anon and authenticated get nothing, and RLS stays
-- on with no policies. Skipped where the role doesn't exist (local databases).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant select, insert, update on table public.gifts, public.prices to service_role;
  end if;
end
$$;
