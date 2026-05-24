use crate::schema;
use crate::types::{
    AccountStatus, ChannelOutboundMessage, LoginResponse, ReactRequest, SuccessResponse,
    TypingRequest,
};
use crate::whatsapp_client::WorkerWhatsAppClient;
use std::cell::RefCell;
use std::time::Duration;
use worker::{
    console_log, durable_object, DurableObject, Env, Method, Request, Response, Result, SqlStorage,
    State,
};

#[durable_object]
pub struct WhatsAppAccount {
    state: State,
    sql: SqlStorage,
    #[allow(dead_code)]
    env: Env,
    client: RefCell<Option<WorkerWhatsAppClient>>,
}

impl DurableObject for WhatsAppAccount {
    fn new(state: State, env: Env) -> Self {
        let sql = state.storage().sql();
        schema::init(&sql);
        Self {
            state,
            sql,
            env,
            client: RefCell::new(None),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let account_id = match self.account_id(&req) {
            Some(account_id) => account_id,
            None => return Response::error("Missing X-Account-Id header", 400),
        };
        self.set_meta("accountId", &account_id)?;

        let url = req.url()?;
        let path = url.path();
        console_log!(
            "[whatsapp-rs.do] accountId={} method={:?} path={}",
            account_id,
            req.method(),
            path
        );

        match (req.method(), path.as_ref()) {
            (Method::Get, "/status") => Response::from_json(&self.status(&account_id)?),
            (Method::Post, "/login") => self.login(&account_id).await,
            (Method::Post, "/logout") => self.logout(&account_id),
            (Method::Post, "/stop") => self.stop(&account_id),
            (Method::Post, "/wake") => self.wake(&account_id).await,
            (Method::Post, "/send") => self.send(&account_id, &mut req).await,
            (Method::Post, "/react") => self.react(&account_id, &mut req).await,
            (Method::Post, "/typing") => self.typing(&account_id, &mut req).await,
            _ => Response::error("Not Found", 404),
        }
    }
}

impl WhatsAppAccount {
    fn account_id(&self, req: &Request) -> Option<String> {
        req.headers()
            .get("X-Account-Id")
            .ok()
            .flatten()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| self.get_meta("accountId").ok().flatten())
    }

    fn status(&self, account_id: &str) -> Result<AccountStatus> {
        let snapshot = self
            .client
            .borrow()
            .as_ref()
            .map(WorkerWhatsAppClient::snapshot);
        Ok(AccountStatus {
            account_id: account_id.to_string(),
            connected: snapshot.as_ref().is_some_and(|value| value.connected),
            authenticated: snapshot.as_ref().is_some_and(|value| value.authenticated),
            mode: "websocket".to_string(),
            self_jid: snapshot
                .as_ref()
                .and_then(|value| value.self_jid.clone())
                .or(self.get_meta("selfJid")?),
            self_e164: snapshot
                .as_ref()
                .and_then(|value| value.self_e164.clone())
                .or(self.get_meta("selfE164")?),
            last_connected_at: snapshot
                .as_ref()
                .and_then(|value| value.last_connected_at)
                .or(self.get_i64_meta("lastConnectedAt")?),
            last_disconnected_at: snapshot
                .as_ref()
                .and_then(|value| value.last_disconnected_at)
                .or(self.get_i64_meta("lastDisconnectedAt")?),
            last_message_at: snapshot
                .as_ref()
                .and_then(|value| value.last_message_at)
                .or(self.get_i64_meta("lastMessageAt")?),
            has_client: snapshot.is_some(),
            implementation: "whatsapp-rs".to_string(),
        })
    }

    async fn login(&self, account_id: &str) -> Result<Response> {
        self.set_meta("lastLoginAttemptAt", &now_ms().to_string())?;
        self.state.storage().set_alarm(now_ms() + 30_000).await?;
        let client = self.ensure_client(account_id).await?;
        let snapshot = client
            .wait_for_login_challenge(Duration::from_secs(60))
            .await;

        if let Some(self_jid) = snapshot.self_jid.as_deref() {
            self.set_meta("selfJid", self_jid)?;
        }
        if let Some(self_e164) = snapshot.self_e164.as_deref() {
            self.set_meta("selfE164", self_e164)?;
        }
        if let Some(last_connected_at) = snapshot.last_connected_at {
            self.set_meta("lastConnectedAt", &last_connected_at.to_string())?;
        }

        Response::from_json(&LoginResponse {
            connected: snapshot.connected && snapshot.authenticated,
            qr: snapshot.qr,
            message: if snapshot.connected && snapshot.authenticated {
                "Connected".to_string()
            } else {
                "Scan QR code with WhatsApp".to_string()
            },
            error: snapshot.last_error,
        })
    }

    fn logout(&self, _account_id: &str) -> Result<Response> {
        if let Some(client) = self.client.borrow_mut().take() {
            self.state.wait_until(async move {
                client.stop().await;
            });
        }
        self.set_meta("selfJid", "")?;
        self.set_meta("selfE164", "")?;
        self.set_meta("lastDisconnectedAt", &now_ms().to_string())?;
        Response::from_json(&SuccessResponse {
            success: true,
            message: Some("Logged out of Rust adapter state".to_string()),
            message_id: None,
            error: None,
            actions: Vec::new(),
            status: None,
        })
    }

    fn stop(&self, _account_id: &str) -> Result<Response> {
        if let Some(client) = self.client.borrow_mut().take() {
            self.state.wait_until(async move {
                client.stop().await;
            });
        }
        self.set_meta("lastDisconnectedAt", &now_ms().to_string())?;
        Response::from_json(&SuccessResponse {
            success: true,
            message: Some("Stopped Rust adapter account object".to_string()),
            message_id: None,
            error: None,
            actions: Vec::new(),
            status: None,
        })
    }

    async fn wake(&self, account_id: &str) -> Result<Response> {
        self.state.storage().set_alarm(now_ms() + 30_000).await?;
        let client = self.ensure_client(account_id).await?;
        let status = self.status(account_id)?;
        Response::from_json(&SuccessResponse {
            success: true,
            message: Some("Wake scheduled and WhatsApp client is running".to_string()),
            message_id: None,
            error: client.snapshot().last_error,
            actions: vec!["scheduled_alarm".to_string(), "client_running".to_string()],
            status: Some(status),
        })
    }

    async fn send(&self, account_id: &str, req: &mut Request) -> Result<Response> {
        let message: ChannelOutboundMessage = req.json().await?;
        let client = self.ensure_client(account_id).await?;
        match client.send(message).await {
            Ok(message_id) => Response::from_json(&SuccessResponse {
                success: true,
                message: Some("Sent".to_string()),
                message_id: Some(message_id),
                error: None,
                actions: Vec::new(),
                status: None,
            }),
            Err(error) => Response::from_json(&SuccessResponse {
                success: false,
                message: None,
                message_id: None,
                error: Some(error.to_string()),
                actions: Vec::new(),
                status: None,
            }),
        }
    }

    async fn react(&self, account_id: &str, req: &mut Request) -> Result<Response> {
        let request: ReactRequest = req.json().await?;
        let client = self.ensure_client(account_id).await?;
        match client.react(request).await {
            Ok(()) => Response::from_json(&SuccessResponse {
                success: true,
                message: Some("Reacted".to_string()),
                message_id: None,
                error: None,
                actions: Vec::new(),
                status: None,
            }),
            Err(error) => Response::from_json(&SuccessResponse {
                success: false,
                message: None,
                message_id: None,
                error: Some(error.to_string()),
                actions: Vec::new(),
                status: None,
            }),
        }
    }

    async fn typing(&self, account_id: &str, req: &mut Request) -> Result<Response> {
        let request: TypingRequest = req.json().await?;
        let client = self.ensure_client(account_id).await?;
        match client.set_typing(request).await {
            Ok(()) => Response::from_json(&SuccessResponse {
                success: true,
                message: None,
                message_id: None,
                error: None,
                actions: Vec::new(),
                status: None,
            }),
            Err(error) => Response::from_json(&SuccessResponse {
                success: false,
                message: None,
                message_id: None,
                error: Some(error.to_string()),
                actions: Vec::new(),
                status: None,
            }),
        }
    }

    async fn ensure_client(&self, account_id: &str) -> Result<WorkerWhatsAppClient> {
        if let Some(client) = self.client.borrow().as_ref() {
            return Ok(client.clone());
        }

        let client = WorkerWhatsAppClient::start(account_id, self.env.clone(), self.sql.clone())
            .await
            .map_err(|error| worker::Error::RustError(error.to_string()))?;
        self.client.borrow_mut().replace(client.clone());
        Ok(client)
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>> {
        #[derive(serde::Deserialize)]
        struct Row {
            value: String,
        }

        let row: Option<Row> = self
            .sql
            .exec(
                "SELECT value FROM account_state WHERE key = ?1",
                vec![worker::SqlStorageValue::from(key.to_string())],
            )?
            .one()
            .ok();
        Ok(row.and_then(|row| {
            if row.value.is_empty() {
                None
            } else {
                Some(row.value)
            }
        }))
    }

    fn get_i64_meta(&self, key: &str) -> Result<Option<i64>> {
        Ok(self
            .get_meta(key)?
            .and_then(|value| value.parse::<i64>().ok()))
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.sql.exec(
            "INSERT INTO account_state (key, value)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            vec![
                worker::SqlStorageValue::from(key.to_string()),
                worker::SqlStorageValue::from(value.to_string()),
            ],
        )?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}
