use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use worker::*;

pub const RESOURCE_HEADER: &str = "X-GSV-Resource-Name";
const BATCH_SIZE: i64 = 16;
const APPLICATION_TABLES: &[&str] = &[
    "issue_comments",
    "issues",
    "fts_head",
    "fts_commits",
    "package_build_cache",
    "package_npm_cache",
    "blob_chunks",
    "blobs",
    "blob_groups",
    "raw_objects",
    "trees",
    "commit_graph",
    "commit_parents",
    "refs",
    "commits",
    "config",
];

/// All application SQL, including late continuations after an HTTP await, shares this fence.
#[derive(Clone)]
pub struct RetirementSql {
    raw: SqlStorage,
    retired: Arc<AtomicBool>,
}

impl RetirementSql {
    pub fn new(raw: SqlStorage) -> Result<Self> {
        let retired = !raw
            .exec("SELECT id FROM installation_retirement", None)?
            .to_array::<serde_json::Value>()?
            .is_empty();
        Ok(Self {
            raw,
            retired: Arc::new(AtomicBool::new(retired)),
        })
    }

    pub fn exec(
        &self,
        query: &str,
        bindings: impl Into<Option<Vec<SqlStorageValue>>>,
    ) -> Result<SqlCursor> {
        self.assert_active()?;
        self.raw.exec(query, bindings)
    }

    pub fn database_size(&self) -> usize {
        self.raw.database_size()
    }

    pub fn assert_active(&self) -> Result<()> {
        if self.retired.load(Ordering::SeqCst) {
            return Err(Error::RustError("Installation is retired".into()));
        }
        Ok(())
    }

    pub fn clear_repository(&self) -> Result<()> {
        self.assert_active()?;
        self.erase_application_data()
    }

    pub fn identify(
        &self,
        state: &State,
        env: &Env,
        name: &str,
        installation_id: &str,
    ) -> Result<()> {
        let namespace = env.durable_object("REPOSITORY")?;
        if namespace.id_from_name(name)? != state.id() {
            return Err(Error::RustError("Resource address mismatch".into()));
        }
        let identity: Vec<Identity> = self
            .raw
            .exec("SELECT name, installation_id FROM resource_identity", None)?
            .to_array()?;
        if let Some(existing) = identity.first() {
            if existing.name != name || existing.installation_id != installation_id {
                return Err(Error::RustError("Resource identity mismatch".into()));
            }
        } else {
            self.assert_active()?;
            self.raw.exec(
                "INSERT INTO resource_identity(id, name, installation_id) VALUES (1, ?, ?)",
                vec![name.into(), installation_id.into()],
            )?;
        }
        Ok(())
    }

    fn begin(&self, input: &RetirementRequest) -> Result<RetirementRow> {
        if input.version != 1
            || !crate::is_valid_installation_id(&input.installation_id)
            || !crate::is_valid_installation_id(&input.operation_id)
            || input.installation_id == "singleton"
        {
            return Err(Error::RustError("Invalid installation retirement".into()));
        }
        let identity: Vec<Identity> = self
            .raw
            .exec("SELECT name, installation_id FROM resource_identity", None)?
            .to_array()?;
        if identity.first().map(|row| row.installation_id.as_str())
            != Some(input.installation_id.as_str())
        {
            return Err(Error::RustError("Retirement identity mismatch".into()));
        }
        let existing: Vec<RetirementRow> = self.raw.exec("SELECT installation_id, operation_id, state, updated_at FROM installation_retirement", None)?.to_array()?;
        if let Some(row) = existing.into_iter().next() {
            if row.installation_id != input.installation_id
                || row.operation_id != input.operation_id
            {
                return Err(Error::RustError("Retirement operation mismatch".into()));
            }
            return Ok(row);
        }
        let updated_at = Date::now().as_millis() as i64;
        self.raw.exec("INSERT INTO installation_retirement(id, installation_id, operation_id, state, updated_at) VALUES (1, ?, ?, 'quiescing', ?)", vec![input.installation_id.clone().into(), input.operation_id.clone().into(), updated_at.into()])?;
        self.retired.store(true, Ordering::SeqCst);
        Ok(RetirementRow {
            installation_id: input.installation_id.clone(),
            operation_id: input.operation_id.clone(),
            state: "quiescing".into(),
        })
    }

    fn phase(&self, state: &str) -> Result<()> {
        self.raw.exec(
            "UPDATE installation_retirement SET state = ?, updated_at = ? WHERE id = 1",
            vec![state.into(), (Date::now().as_millis() as i64).into()],
        )?;
        Ok(())
    }

    fn erase_application_data(&self) -> Result<()> {
        self.assert_known_tables()?;
        // The fence stays closed throughout. Partial failure resumes these idempotent deletes.
        // Child rows precede their parents; FTS virtual tables own their shadow tables.
        for table in APPLICATION_TABLES {
            self.raw.exec(&format!("DELETE FROM {table}"), None)?;
        }
        self.raw.exec("DELETE FROM sqlite_sequence", None)?;
        Ok(())
    }

    pub fn inspect(&self) -> Result<Response> {
        self.assert_known_tables()?;
        let identity: Vec<Identity> = self
            .raw
            .exec("SELECT name, installation_id FROM resource_identity", None)?
            .to_array()?;
        let mut empty = true;
        for table in APPLICATION_TABLES
            .iter()
            .copied()
            .chain(["installation_resources"])
        {
            if !self
                .raw
                .exec(&format!("SELECT 1 FROM {table} LIMIT 1"), None)?
                .to_array::<serde_json::Value>()?
                .is_empty()
            {
                empty = false;
                break;
            }
        }
        let mut result = serde_json::json!({ "empty": empty });
        if let Some(identity) = identity.first() {
            result["name"] = identity.name.clone().into();
        }
        Response::from_json(&result)
    }

    fn assert_known_tables(&self) -> Result<()> {
        let tables: Vec<Resource> = self
            .raw
            .exec(
                "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type != 'shadow'",
                None,
            )?
            .to_array()?;
        for table in tables {
            if APPLICATION_TABLES.contains(&table.name.as_str())
                || matches!(
                    table.name.as_str(),
                    "_gsv_schema_migrations"
                        | "resource_identity"
                        | "installation_resources"
                        | "installation_retirement"
                )
                || table.name.starts_with("sqlite_")
                || table.name.to_lowercase().starts_with("_cf_")
                || table.name.to_lowercase().starts_with("__cf_")
            {
                continue;
            }
            return Err(Error::RustError(
                "Repository schema has no erasure policy for a table".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct Identity {
    name: String,
    installation_id: String,
}

#[derive(Deserialize)]
struct RetirementRow {
    installation_id: String,
    operation_id: String,
    state: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetirementRequest {
    pub version: u8,
    pub installation_id: String,
    pub operation_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    version: u8,
    installation_id: String,
    operation_id: String,
    phase: String,
    pending_resources: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    installation_id: String,
    resource_name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InventoryImport {
    installation_id: String,
    names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    object_id: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct Resource {
    name: String,
}

pub fn index_name(installation_id: &str) -> String {
    format!("installation-index:{installation_id}")
}

async fn request_object(
    env: &Env,
    name: &str,
    installation_id: &str,
    path: &str,
    body: &impl Serialize,
) -> Result<Response> {
    let namespace = env.durable_object("REPOSITORY")?;
    let stub = namespace.id_from_name(name)?.get_stub()?;
    let headers = Headers::new();
    headers.set(RESOURCE_HEADER, name)?;
    headers.set(crate::INSTALLATION_HEADER, installation_id)?;
    headers.set("Content-Type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(serde_json::to_string(body)?.into()));
    stub.fetch_with_request(Request::new_with_init(
        &format!("https://ripgit.invalid{path}"),
        &init,
    )?)
    .await
}

pub async fn register(env: &Env, installation_id: &str, resource_name: &str) -> Result<()> {
    if installation_id == "singleton" {
        return Ok(());
    }
    let body = Registration {
        installation_id: installation_id.into(),
        resource_name: resource_name.into(),
    };
    let response = request_object(
        env,
        &index_name(installation_id),
        installation_id,
        "/.gsv/index/register",
        &body,
    )
    .await?;
    if response.status_code() != 204 {
        return Err(Error::RustError("Repository admission is closed".into()));
    }
    Ok(())
}

pub async fn forward_lifecycle(mut request: Request, env: &Env, action: &str) -> Result<Response> {
    if request.method() != Method::Post || !matches!(action, "quiesce" | "erase") {
        return Response::error("Not found", 404);
    }
    let input: RetirementRequest = request.json().await?;
    if !crate::is_valid_installation_id(&input.installation_id)
        || input.installation_id == "singleton"
    {
        return Response::error("Invalid installation", 400);
    }
    request_object(
        env,
        &index_name(&input.installation_id),
        &input.installation_id,
        &format!("/.gsv/index/{action}"),
        &input,
    )
    .await
}

pub async fn forward_discovery(mut request: Request, env: &Env, action: &str) -> Result<Response> {
    if request.method() != Method::Post {
        return Response::error("Not found", 404);
    }
    if action == "inspect" {
        let input: Inspection = request.json().await?;
        let namespace = env.durable_object("REPOSITORY")?;
        let id = namespace.id_from_string(&input.object_id)?;
        if let Some(name) = input.name {
            if namespace.id_from_name(&name)? != id {
                return Response::error("Resource address mismatch", 400);
            }
        }
        return id
            .get_stub()?
            .fetch_with_str("https://ripgit.invalid/.gsv/resource/inspect")
            .await;
    }
    if action == "import" {
        let input: InventoryImport = request.json().await?;
        if !crate::is_valid_installation_id(&input.installation_id)
            || input.installation_id == "singleton"
            || input.names.len() > 16
        {
            return Response::error("Invalid inventory import", 400);
        }
        return request_object(
            env,
            &index_name(&input.installation_id),
            &input.installation_id,
            "/.gsv/index/import",
            &input,
        )
        .await;
    }
    Response::error("Not found", 404)
}

/// Internal index/repository operations. Only the Worker dispatcher can address these objects.
pub async fn handle(
    sql: &RetirementSql,
    state: &State,
    env: &Env,
    mut request: Request,
) -> Result<Response> {
    let path = request.url()?.path().to_string();
    if path == "/.gsv/index/import" {
        let input: InventoryImport = request.json().await?;
        if env
            .durable_object("REPOSITORY")?
            .id_from_name(&index_name(&input.installation_id))?
            != state.id()
        {
            return Response::error("Invalid installation inventory", 400);
        }
        for name in input.names {
            if name == index_name(&input.installation_id) {
                continue;
            }
            if !name.starts_with(&format!("{}/", input.installation_id))
                || name.split('/').count() != 3
            {
                return Response::error("Inventory resource belongs to another installation", 400);
            }
            sql.raw.exec(
                "INSERT INTO installation_resources(name) VALUES (?) ON CONFLICT(name) DO NOTHING",
                vec![name.into()],
            )?;
        }
        return Response::empty().map(|response| response.with_status(204));
    }
    if path == "/.gsv/index/register" {
        sql.assert_active()?;
        let input: Registration = request.json().await?;
        // Recheck after consuming the body; quiescence may have interleaved.
        sql.assert_active()?;
        if !input
            .resource_name
            .starts_with(&format!("{}/", input.installation_id))
            || env
                .durable_object("REPOSITORY")?
                .id_from_name(&index_name(&input.installation_id))?
                != state.id()
        {
            return Response::error("Invalid resource registration", 400);
        }
        sql.raw.exec(
            "INSERT INTO installation_resources(name) VALUES (?) ON CONFLICT(name) DO NOTHING",
            vec![input.resource_name.into()],
        )?;
        return Response::empty().map(|response| response.with_status(204));
    }
    let input: RetirementRequest = request.json().await?;
    let current = sql.begin(&input)?;
    let is_index = path.starts_with("/.gsv/index/");
    let action = path.rsplit('/').next().unwrap_or("");
    if !matches!(action, "quiesce" | "erase") {
        return Response::error("Not found", 404);
    }
    if current.state == "live-erased" {
        return progress(&input, "live-erased", 0);
    }
    let desired = if action == "quiesce" {
        "quiesced"
    } else {
        "live-erased"
    };
    if action == "erase" && current.state == "quiescing" {
        return progress(&input, "quiescing", 1);
    }
    if is_index {
        let from = if action == "quiesce" {
            "live"
        } else {
            "quiesced"
        };
        let resources: Vec<Resource> = sql
            .raw
            .exec(
                "SELECT name FROM installation_resources WHERE state = ? ORDER BY name LIMIT ?",
                vec![from.into(), BATCH_SIZE.into()],
            )?
            .to_array()?;
        for resource in resources {
            let mut response = request_object(
                env,
                &resource.name,
                &input.installation_id,
                &format!("/.gsv/resource/{action}"),
                &input,
            )
            .await?;
            if response.status_code() != 200 {
                return Err(Error::RustError("Repository retirement failed".into()));
            }
            let receipt: Progress = response.json().await?;
            if receipt.version != 1
                || receipt.installation_id != input.installation_id
                || receipt.operation_id != input.operation_id
                || receipt.phase != desired
            {
                return Err(Error::RustError(
                    "Repository retirement receipt mismatch".into(),
                ));
            }
            sql.raw.exec(
                "UPDATE installation_resources SET state = ? WHERE name = ?",
                vec![desired.into(), resource.name.into()],
            )?;
        }
        let pending: Vec<serde_json::Value> = sql
            .raw
            .exec(
                "SELECT name FROM installation_resources WHERE state = ?",
                vec![from.into()],
            )?
            .to_array()?;
        if !pending.is_empty() {
            return progress(&input, &current.state, pending.len());
        }
    }
    if action == "erase" {
        sql.erase_application_data()?;
        sql.raw.exec("DELETE FROM installation_resources", None)?;
    }
    state.storage().delete_alarm().await?;
    sql.phase(desired)?;
    progress(&input, desired, 0)
}

fn progress(input: &RetirementRequest, phase: &str, pending_resources: usize) -> Result<Response> {
    Response::from_json(&Progress {
        version: 1,
        installation_id: input.installation_id.clone(),
        operation_id: input.operation_id.clone(),
        phase: phase.into(),
        pending_resources,
    })
}
