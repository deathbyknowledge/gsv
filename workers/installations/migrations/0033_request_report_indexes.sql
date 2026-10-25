-- A closed report keeps the sender's name and message for 90 days; the Accounts
-- cron finds the reports that still hold one by when they closed.
CREATE INDEX request_reports_messages ON request_reports (closed_at) WHERE message_text IS NOT NULL;

-- A report's trail is every operator audit event whose detail names the report.
CREATE INDEX operator_audit_events_report ON operator_audit_events (json_extract(detail_json, '$.report'));
