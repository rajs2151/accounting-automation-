-- Synthetic demo owner user "Raj" (admin) for the demo login picker.
-- Admin can approve documents prepared by others; dual control still blocks approving his own (dual-control.ts).
-- Access limited to the three synthetic books companies (same as Layla); legacy Stage B clients are untouched
-- so firm-pipeline / RLS isolation tests keep their meaning.

INSERT INTO users (id, firm_id, email, name, role) VALUES
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'raj@arnibooks.test', 'Raj', 'admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_client_access (user_id, client_id) VALUES
  ('77777777-7777-4777-8777-777777777777', 'e1000001-0000-4000-8000-000000000001'),
  ('77777777-7777-4777-8777-777777777777', 'e1000001-0000-4000-8000-000000000002'),
  ('77777777-7777-4777-8777-777777777777', 'e1000001-0000-4000-8000-000000000003')
ON CONFLICT DO NOTHING;
