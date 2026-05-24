use async_trait::async_trait;
use bytes::Bytes;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use wacore::appstate::hash::HashState;
use wacore::appstate::processor::AppStateMutationMAC;
use wacore::store::error::{Result as StoreResult, StoreError};
use wacore::store::traits::{
    AppStateSyncKey, AppSyncStore, DeviceListRecord, DeviceStore, LidPnMappingEntry, ProtocolStore,
    SignalStore, TcTokenEntry,
};
use wacore::store::Device;
use worker::{SqlStorage, SqlStorageValue};

#[derive(Clone, Debug)]
pub struct SqliteWhatsAppStore {
    sql: SqlStorage,
}

#[derive(Debug)]
struct BackendError(String);

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BackendError {}

#[derive(Deserialize)]
struct BlobRow {
    value: Vec<u8>,
}

#[derive(Deserialize)]
struct KeyBlobRow {
    key: String,
    value: Vec<u8>,
}

#[derive(Deserialize)]
struct KeyRow {
    key: String,
}

impl SqliteWhatsAppStore {
    pub fn new(sql: SqlStorage) -> Self {
        Self { sql }
    }

    fn set_blob(&self, domain: &str, key: &str, value: &[u8]) -> StoreResult<()> {
        self.sql
            .exec(
                "INSERT INTO whatsapp_store (domain, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(domain, key)
                 DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                vec![
                    SqlStorageValue::from(domain),
                    SqlStorageValue::from(key),
                    SqlStorageValue::from(value.to_vec()),
                    SqlStorageValue::from(now_secs()),
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    fn get_blob(&self, domain: &str, key: &str) -> StoreResult<Option<Vec<u8>>> {
        let mut rows: Vec<BlobRow> = self
            .sql
            .exec(
                "SELECT value FROM whatsapp_store WHERE domain = ?1 AND key = ?2 LIMIT 1",
                vec![SqlStorageValue::from(domain), SqlStorageValue::from(key)],
            )
            .map_err(database_error)?
            .to_array()
            .map_err(database_error)?;
        Ok(rows.pop().map(|row| row.value))
    }

    fn delete_blob(&self, domain: &str, key: &str) -> StoreResult<()> {
        self.sql
            .exec(
                "DELETE FROM whatsapp_store WHERE domain = ?1 AND key = ?2",
                vec![SqlStorageValue::from(domain), SqlStorageValue::from(key)],
            )
            .map_err(database_error)?;
        Ok(())
    }

    fn delete_domain(&self, domain: &str) -> StoreResult<()> {
        self.sql
            .exec(
                "DELETE FROM whatsapp_store WHERE domain = ?1",
                vec![SqlStorageValue::from(domain)],
            )
            .map_err(database_error)?;
        Ok(())
    }

    fn list_domain(&self, domain: &str) -> StoreResult<Vec<KeyBlobRow>> {
        self.sql
            .exec(
                "SELECT key, value FROM whatsapp_store WHERE domain = ?1",
                vec![SqlStorageValue::from(domain)],
            )
            .map_err(database_error)?
            .to_array()
            .map_err(database_error)
    }

    fn list_keys(&self, domain: &str) -> StoreResult<Vec<String>> {
        let rows: Vec<KeyRow> = self
            .sql
            .exec(
                "SELECT key FROM whatsapp_store WHERE domain = ?1",
                vec![SqlStorageValue::from(domain)],
            )
            .map_err(database_error)?
            .to_array()
            .map_err(database_error)?;
        Ok(rows.into_iter().map(|row| row.key).collect())
    }

    fn set_json<T: Serialize>(&self, domain: &str, key: &str, value: &T) -> StoreResult<()> {
        let bytes = serde_json::to_vec(value).map_err(serialization_error)?;
        self.set_blob(domain, key, &bytes)
    }

    fn get_json<T: DeserializeOwned>(&self, domain: &str, key: &str) -> StoreResult<Option<T>> {
        self.get_blob(domain, key)?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(serialization_error))
            .transpose()
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl SignalStore for SqliteWhatsAppStore {
    async fn put_identity(&self, address: &str, key: [u8; 32]) -> StoreResult<()> {
        self.set_blob("identity", address, &key)
    }

    async fn load_identity(&self, address: &str) -> StoreResult<Option<[u8; 32]>> {
        self.get_blob("identity", address)?
            .map(bytes_to_32)
            .transpose()
    }

    async fn delete_identity(&self, address: &str) -> StoreResult<()> {
        self.delete_blob("identity", address)
    }

    async fn get_session(&self, address: &str) -> StoreResult<Option<Bytes>> {
        Ok(self.get_blob("session", address)?.map(Bytes::from))
    }

    async fn put_session(&self, address: &str, session: &[u8]) -> StoreResult<()> {
        self.set_blob("session", address, session)
    }

    async fn delete_session(&self, address: &str) -> StoreResult<()> {
        self.delete_blob("session", address)
    }

    async fn has_session(&self, address: &str) -> StoreResult<bool> {
        Ok(self.get_blob("session", address)?.is_some())
    }

    async fn store_prekey(&self, id: u32, record: &[u8], _uploaded: bool) -> StoreResult<()> {
        self.set_blob("prekey", &id.to_string(), record)
    }

    async fn store_prekeys_batch(&self, keys: &[(u32, Bytes)], uploaded: bool) -> StoreResult<()> {
        for (id, record) in keys {
            self.store_prekey(*id, record, uploaded).await?;
        }
        Ok(())
    }

    async fn load_prekey(&self, id: u32) -> StoreResult<Option<Bytes>> {
        Ok(self.get_blob("prekey", &id.to_string())?.map(Bytes::from))
    }

    async fn load_prekeys_batch(&self, ids: &[u32]) -> StoreResult<Vec<(u32, Bytes)>> {
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(record) = self.load_prekey(*id).await? {
                result.push((*id, record));
            }
        }
        Ok(result)
    }

    async fn remove_prekey(&self, id: u32) -> StoreResult<()> {
        self.delete_blob("prekey", &id.to_string())
    }

    async fn get_max_prekey_id(&self) -> StoreResult<u32> {
        Ok(self
            .list_keys("prekey")?
            .into_iter()
            .filter_map(|key| key.parse::<u32>().ok())
            .max()
            .unwrap_or(0))
    }

    async fn store_signed_prekey(&self, id: u32, record: &[u8]) -> StoreResult<()> {
        self.set_blob("signed_prekey", &id.to_string(), record)
    }

    async fn load_signed_prekey(&self, id: u32) -> StoreResult<Option<Vec<u8>>> {
        self.get_blob("signed_prekey", &id.to_string())
    }

    async fn load_all_signed_prekeys(&self) -> StoreResult<Vec<(u32, Vec<u8>)>> {
        let mut rows = Vec::new();
        for row in self.list_domain("signed_prekey")? {
            if let Ok(id) = row.key.parse::<u32>() {
                rows.push((id, row.value));
            }
        }
        Ok(rows)
    }

    async fn remove_signed_prekey(&self, id: u32) -> StoreResult<()> {
        self.delete_blob("signed_prekey", &id.to_string())
    }

    async fn put_sender_key(&self, address: &str, record: &[u8]) -> StoreResult<()> {
        self.set_blob("sender_key", address, record)
    }

    async fn get_sender_key(&self, address: &str) -> StoreResult<Option<Vec<u8>>> {
        self.get_blob("sender_key", address)
    }

    async fn delete_sender_key(&self, address: &str) -> StoreResult<()> {
        self.delete_blob("sender_key", address)
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl AppSyncStore for SqliteWhatsAppStore {
    async fn get_sync_key(&self, key_id: &[u8]) -> StoreResult<Option<AppStateSyncKey>> {
        self.get_json("sync_key", &hex_encode(key_id))
    }

    async fn set_sync_key(&self, key_id: &[u8], key: AppStateSyncKey) -> StoreResult<()> {
        self.set_json("sync_key", &hex_encode(key_id), &key)?;
        self.set_blob("sync_key_meta", "latest", key_id)
    }

    async fn get_version(&self, name: &str) -> StoreResult<HashState> {
        Ok(self
            .get_json("app_state_version", name)?
            .unwrap_or_default())
    }

    async fn set_version(&self, name: &str, state: HashState) -> StoreResult<()> {
        self.set_json("app_state_version", name, &state)
    }

    async fn put_mutation_macs(
        &self,
        name: &str,
        _version: u64,
        mutations: &[AppStateMutationMAC],
    ) -> StoreResult<()> {
        for mutation in mutations {
            self.set_blob(
                "mutation_mac",
                &pair_key(name, &hex_encode(&mutation.index_mac)),
                &mutation.value_mac,
            )?;
        }
        Ok(())
    }

    async fn get_mutation_mac(&self, name: &str, index_mac: &[u8]) -> StoreResult<Option<Vec<u8>>> {
        self.get_blob("mutation_mac", &pair_key(name, &hex_encode(index_mac)))
    }

    async fn delete_mutation_macs(&self, name: &str, index_macs: &[Vec<u8>]) -> StoreResult<()> {
        for index_mac in index_macs {
            self.delete_blob("mutation_mac", &pair_key(name, &hex_encode(index_mac)))?;
        }
        Ok(())
    }

    async fn get_latest_sync_key_id(&self) -> StoreResult<Option<Vec<u8>>> {
        self.get_blob("sync_key_meta", "latest")
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ProtocolStore for SqliteWhatsAppStore {
    async fn get_sender_key_devices(&self, group_jid: &str) -> StoreResult<Vec<(String, bool)>> {
        let map: HashMap<String, bool> = self
            .get_json("sender_key_devices", group_jid)?
            .unwrap_or_default();
        Ok(map.into_iter().collect())
    }

    async fn set_sender_key_status(
        &self,
        group_jid: &str,
        entries: &[(&str, bool)],
    ) -> StoreResult<()> {
        let mut map: HashMap<String, bool> = self
            .get_json("sender_key_devices", group_jid)?
            .unwrap_or_default();
        for (device_jid, has_key) in entries {
            map.insert((*device_jid).to_string(), *has_key);
        }
        self.set_json("sender_key_devices", group_jid, &map)
    }

    async fn clear_sender_key_devices(&self, group_jid: &str) -> StoreResult<()> {
        self.delete_blob("sender_key_devices", group_jid)
    }

    async fn delete_sender_key_device_rows(&self, device_jids: &[&str]) -> StoreResult<()> {
        if device_jids.is_empty() {
            return Ok(());
        }
        let targets: HashSet<&str> = device_jids.iter().copied().collect();
        for row in self.list_domain("sender_key_devices")? {
            let mut map: HashMap<String, bool> =
                serde_json::from_slice(&row.value).map_err(serialization_error)?;
            let before = map.len();
            map.retain(|device_jid, _| !targets.contains(device_jid.as_str()));
            if map.len() == before {
                continue;
            }
            if map.is_empty() {
                self.delete_blob("sender_key_devices", &row.key)?;
            } else {
                self.set_json("sender_key_devices", &row.key, &map)?;
            }
        }
        Ok(())
    }

    async fn clear_all_sender_key_devices(&self) -> StoreResult<()> {
        self.delete_domain("sender_key_devices")
    }

    async fn get_lid_mapping(&self, lid: &str) -> StoreResult<Option<LidPnMappingEntry>> {
        self.get_json("lid_mapping", lid)
    }

    async fn get_pn_mapping(&self, phone: &str) -> StoreResult<Option<LidPnMappingEntry>> {
        match self.get_blob("pn_mapping", phone)? {
            Some(lid) => {
                let lid = String::from_utf8(lid).map_err(validation_error)?;
                self.get_lid_mapping(&lid).await
            }
            None => Ok(None),
        }
    }

    async fn put_lid_mapping(&self, entry: &LidPnMappingEntry) -> StoreResult<()> {
        if let Some(old) = self.get_lid_mapping(&entry.lid).await? {
            if old.phone_number != entry.phone_number {
                self.delete_blob("pn_mapping", &old.phone_number)?;
            }
        }
        self.set_blob("pn_mapping", &entry.phone_number, entry.lid.as_bytes())?;
        self.set_json("lid_mapping", &entry.lid, entry)
    }

    async fn put_lid_mappings(&self, entries: &[LidPnMappingEntry]) -> StoreResult<()> {
        for entry in entries {
            self.put_lid_mapping(entry).await?;
        }
        Ok(())
    }

    async fn get_all_lid_mappings(&self) -> StoreResult<Vec<LidPnMappingEntry>> {
        self.list_domain("lid_mapping")?
            .into_iter()
            .map(|row| serde_json::from_slice(&row.value).map_err(serialization_error))
            .collect()
    }

    async fn save_base_key(
        &self,
        address: &str,
        message_id: &str,
        base_key: &[u8],
    ) -> StoreResult<()> {
        self.set_blob("base_key", &pair_key(address, message_id), base_key)
    }

    async fn has_same_base_key(
        &self,
        address: &str,
        message_id: &str,
        current_base_key: &[u8],
    ) -> StoreResult<bool> {
        Ok(self
            .get_blob("base_key", &pair_key(address, message_id))?
            .is_some_and(|stored| stored == current_base_key))
    }

    async fn delete_base_key(&self, address: &str, message_id: &str) -> StoreResult<()> {
        self.delete_blob("base_key", &pair_key(address, message_id))
    }

    async fn update_device_list(&self, record: DeviceListRecord) -> StoreResult<()> {
        self.set_json("device_list", &record.user, &record)
    }

    async fn update_device_lists(&self, records: Vec<DeviceListRecord>) -> StoreResult<()> {
        for record in records {
            self.update_device_list(record).await?;
        }
        Ok(())
    }

    async fn get_devices(&self, user: &str) -> StoreResult<Option<DeviceListRecord>> {
        self.get_json("device_list", user)
    }

    async fn delete_devices(&self, user: &str) -> StoreResult<()> {
        self.delete_blob("device_list", user)
    }

    async fn get_tc_token(&self, jid: &str) -> StoreResult<Option<TcTokenEntry>> {
        self.get_json("tc_token", jid)
    }

    async fn put_tc_token(&self, jid: &str, entry: &TcTokenEntry) -> StoreResult<()> {
        self.set_json("tc_token", jid, entry)
    }

    async fn delete_tc_token(&self, jid: &str) -> StoreResult<()> {
        self.delete_blob("tc_token", jid)
    }

    async fn get_all_tc_token_jids(&self) -> StoreResult<Vec<String>> {
        self.list_keys("tc_token")
    }

    async fn delete_expired_tc_tokens(&self, cutoff_timestamp: i64) -> StoreResult<u32> {
        let mut deleted = 0;
        for row in self.list_domain("tc_token")? {
            let entry: TcTokenEntry =
                serde_json::from_slice(&row.value).map_err(serialization_error)?;
            if entry.token_timestamp < cutoff_timestamp {
                self.delete_blob("tc_token", &row.key)?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    async fn store_sent_message(
        &self,
        chat_jid: &str,
        message_id: &str,
        payload: &[u8],
    ) -> StoreResult<()> {
        self.set_blob("sent_message", &pair_key(chat_jid, message_id), payload)
    }

    async fn take_sent_message(
        &self,
        chat_jid: &str,
        message_id: &str,
    ) -> StoreResult<Option<Vec<u8>>> {
        let key = pair_key(chat_jid, message_id);
        let payload = self.get_blob("sent_message", &key)?;
        if payload.is_some() {
            self.delete_blob("sent_message", &key)?;
        }
        Ok(payload)
    }

    async fn delete_expired_sent_messages(&self, cutoff_timestamp: i64) -> StoreResult<u32> {
        let cursor = self
            .sql
            .exec(
                "DELETE FROM whatsapp_store
                 WHERE domain = ?1 AND updated_at < ?2",
                vec![
                    SqlStorageValue::from("sent_message"),
                    SqlStorageValue::from(cutoff_timestamp),
                ],
            )
            .map_err(database_error)?;
        Ok(cursor.rows_written() as u32)
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl DeviceStore for SqliteWhatsAppStore {
    async fn save(&self, device: &Device) -> StoreResult<()> {
        self.set_json("device", "primary", device)
    }

    async fn load(&self) -> StoreResult<Option<Device>> {
        self.get_json("device", "primary")
    }

    async fn exists(&self) -> StoreResult<bool> {
        Ok(self.get_blob("device", "primary")?.is_some())
    }

    async fn create(&self) -> StoreResult<i32> {
        if !self.exists().await? {
            self.save(&Device::new()).await?;
        }
        Ok(1)
    }
}

fn bytes_to_32(bytes: Vec<u8>) -> StoreResult<[u8; 32]> {
    bytes.try_into().map_err(|bytes: Vec<u8>| {
        StoreError::Validation(format!("expected 32 bytes, got {}", bytes.len()))
    })
}

fn pair_key(left: &str, right: &str) -> String {
    format!(
        "{}:{}",
        hex_encode(left.as_bytes()),
        hex_encode(right.as_bytes())
    )
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn now_secs() -> i64 {
    (js_sys::Date::now() / 1000.0).floor() as i64
}

fn database_error(error: impl ToString) -> StoreError {
    StoreError::Database(Box::new(BackendError(error.to_string())))
}

fn serialization_error(error: impl std::error::Error + Send + Sync + 'static) -> StoreError {
    StoreError::Serialization(Box::new(error))
}

fn validation_error(error: impl ToString) -> StoreError {
    StoreError::Validation(error.to_string())
}
