mod account;
mod platform;
mod rpc;
mod schema;
mod store;
mod types;
mod whatsapp_client;

pub use account::WhatsAppAccount;
use worker::{event, Env, Method, Request, RequestInit, Response, Result};

#[event(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path();

    if path == "/" || path == "/health" {
        return Response::from_json(&serde_json::json!({
            "service": "gsv-channel-whatsapp-rs",
            "status": "ok",
            "implementation": "workers-rs",
            "usage": {
                "login": "POST /account/:accountId/login",
                "logout": "POST /account/:accountId/logout",
                "wake": "POST /account/:accountId/wake",
                "stop": "POST /account/:accountId/stop",
                "status": "GET /account/:accountId/status"
            }
        }));
    }

    if path == "/accounts" {
        return Response::from_json(&serde_json::json!({
            "message": "Account listing is not implemented; use /account/:accountId/status.",
            "accounts": []
        }));
    }

    if let Some((account_id, sub_path)) = match_account_route(&path) {
        return forward_account_request(req, &env, &account_id, &sub_path).await;
    }

    Response::error("Not Found", 404)
}

fn match_account_route(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/account/")?;
    let (account_id, sub_path) = match rest.split_once('/') {
        Some((account_id, sub_path)) => (account_id, format!("/{sub_path}")),
        None => (rest, "/status".to_string()),
    };
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return None;
    }
    Some((account_id.to_string(), sub_path))
}

async fn forward_account_request(
    mut req: Request,
    env: &Env,
    account_id: &str,
    sub_path: &str,
) -> Result<Response> {
    let namespace = env.durable_object("WHATSAPP_ACCOUNT")?;
    let id = namespace.id_from_name(account_id)?;
    let stub = id.get_stub()?;
    let mut url = req.url()?;
    url.set_path(sub_path);

    let headers = req.headers().clone();
    headers.set("X-Account-Id", account_id)?;

    let method = req.method();
    let mut init = RequestInit::new();
    init.with_method(method.clone());
    init.with_headers(headers);
    if !matches!(method, Method::Get | Method::Head) {
        let body = req.bytes().await?;
        init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    }

    let forwarded = Request::new_with_init(url.as_str(), &init)?;
    stub.fetch_with_request(forwarded).await
}
