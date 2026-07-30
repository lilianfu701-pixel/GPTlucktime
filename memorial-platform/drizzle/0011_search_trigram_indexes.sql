-- Trigram support for name search.
--
-- Names are matched by substring rather than by word, because most of the
-- launch languages do not separate words the way a full-text tokenizer expects:
-- to_tsvector cannot find a two-character Chinese name inside a longer one, and
-- a family searching for a relative would get nothing back.
--
-- One index, on normalized_text. The indexer folds searchable aliases and place
-- tokens into that column precisely so a single index covers them: an index on
-- array_to_string(...) is rejected by PostgreSQL because the function is STABLE
-- rather than IMMUTABLE. The arrays remain for structured filtering and display.
--
-- The index serves queries of three characters or more. Shorter ones -- common
-- in Chinese, Japanese and Korean -- cannot use a trigram index and fall back to
-- a scan. That is a known scaling limit, recorded in modules/search/README.md,
-- not something this migration quietly papers over.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_documents_normalized_text_trgm"
  ON "search_documents" USING gin ("normalized_text" gin_trgm_ops);
