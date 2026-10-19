-- ADR-017 RECOV-1: Recovery authorization protocol
-- Scoped, time-bound authorizations for recovery operations under maintenance fence.

CREATE TABLE IF NOT EXISTS recovery_authorizations (
  auth_id UUID PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('repair', 'restore-reconcile')),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_auth_expires ON recovery_authorizations(expires_at);
