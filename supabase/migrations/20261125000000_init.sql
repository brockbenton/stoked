-- Initial schema: 1:1 gifts. See docs/build-plan.md § Data.
-- RLS is on with no policies: only the server (service role) reads or writes.

create table gifts (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('wrapped','opened','claiming','claimed')),
  sender_name text not null,
  recipient_name text not null,
  ticker text not null,                -- token symbol, e.g. 'tNVDA'
  usd_cents integer not null check (usd_cents > 0),
  price_cents integer not null,        -- price used to size the gift
  token_raw numeric(39,0) not null,    -- raw units reserved for the gift
  note text,
  opens_at timestamptz,
  claim_token_hash text not null,      -- sha256; the plain token is returned once
  recipient_wallet text,
  claim_signature text,
  claim_last_valid_height bigint,
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  claimed_at timestamptz
);

create table prices (
  ticker text primary key,             -- token symbol, e.g. 'tNVDA'
  usd_cents integer not null,
  source text not null,
  updated_at timestamptz not null default now()
);

alter table gifts enable row level security;
alter table prices enable row level security;
