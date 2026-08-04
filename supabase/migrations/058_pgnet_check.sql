-- 058_check_pgnet_log.sql — read net._http_response to see what
-- happened with the most recent push dispatch attempts.
CREATE TABLE IF NOT EXISTS _pgnet_log (
  id bigserial PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  response_id bigint,
  status_code integer,
  error_msg text
);
TRUNCATE _pgnet_log;
INSERT INTO _pgnet_log (response_id, status_code, error_msg)
SELECT id, status_code, error_msg
FROM net._http_response
ORDER BY id DESC
LIMIT 10;