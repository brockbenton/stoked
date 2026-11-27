-- Escrow gifts (docs/escrow.md): the on-chain account holding this gift's
-- tokens. Null for gifts the treasury transfers at claim time.
alter table gifts add column escrow_account text;
