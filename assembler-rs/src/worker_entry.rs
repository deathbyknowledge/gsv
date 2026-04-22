use serde_json::json;
use worker::*;

#[event(fetch)]
async fn fetch(_req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    Response::from_json(&json!({
        "name": "assembler-rs",
        "version": env!("CARGO_PKG_VERSION"),
        "status": "pipeline-scaffold"
    }))
}
