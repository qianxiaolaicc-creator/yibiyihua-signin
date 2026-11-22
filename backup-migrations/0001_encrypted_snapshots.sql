CREATE TABLE snapshots (
  date TEXT PRIMARY KEY NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext BLOB NOT NULL
);
