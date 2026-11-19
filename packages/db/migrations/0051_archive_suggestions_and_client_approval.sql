-- An agent's request to delete (archive) a page is a suggestion of kind 'archive' (kind is plain text: no
-- constraint to change). An agent's owner may approve and reject its changes in the AI client's review panel
-- unless this is turned off. Hand-written.
ALTER TABLE "agents" ADD COLUMN "approve_in_client" boolean DEFAULT true NOT NULL;
