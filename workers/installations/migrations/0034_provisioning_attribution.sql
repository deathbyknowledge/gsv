-- Where a signup came from, as the closed slugs the website put in the signup
-- link (a placement name and an example id), never a visitor identity. Set
-- once when the reservation is made and reported when activation completes.
ALTER TABLE provisioning_operations ADD COLUMN attribution_json TEXT;
