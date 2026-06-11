-- Ensure a user can only have one pending/public status submission per source album.
CREATE UNIQUE INDEX "PublicAlbumSubmission_source_album_id_submitted_by_user_id_status_key"
  ON "PublicAlbumSubmission" ("source_album_id", "submitted_by_user_id", "status");
