-- Upload guardrails: store the R2 object checksum (ETag) for each uploaded file,
-- captured server-side after the upload is verified. Idempotent.
alter table item_files add column if not exists checksum text;
