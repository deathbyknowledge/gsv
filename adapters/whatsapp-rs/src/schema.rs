use worker::SqlStorage;

pub fn init(sql: &SqlStorage) {
    sql.exec(
        "CREATE TABLE IF NOT EXISTS account_state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        None,
    )
    .expect("create account_state");

    sql.exec(
        "CREATE TABLE IF NOT EXISTS whatsapp_store (
            domain      TEXT NOT NULL,
            key         TEXT NOT NULL,
            value       BLOB NOT NULL,
            updated_at  INTEGER NOT NULL,
            PRIMARY KEY (domain, key)
        )",
        None,
    )
    .expect("create whatsapp_store");

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_whatsapp_store_domain
         ON whatsapp_store(domain)",
        None,
    )
    .expect("create idx_whatsapp_store_domain");

    sql.exec(
        "CREATE TABLE IF NOT EXISTS event_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL,
            payload     TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        )",
        None,
    )
    .expect("create event_log");
}
