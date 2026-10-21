use std::time::Duration;
use worker::wasm_bindgen::{prelude::*, JsCast};
use worker::wasm_bindgen_futures::JsFuture;
use worker::*;

// worker::Error stringifies JS exceptions, losing the platform retry/overload flags.
#[wasm_bindgen]
extern "C" {
    type RepositoryStub;
    #[wasm_bindgen(method, catch, js_name = fetch)]
    fn fetch_request(
        this: &RepositoryStub,
        request: &web_sys::Request,
    ) -> std::result::Result<js_sys::Promise, JsValue>;
}

/// Only bodyless reads may be replayed after a transient dispatch failure.
pub async fn repository_fetch(env: &Env, name: &str, request: Request) -> Result<Response> {
    let namespace = env.durable_object("REPOSITORY")?;
    if !matches!(request.method(), Method::Get | Method::Head) {
        return namespace
            .id_from_name(name)?
            .get_stub()?
            .fetch_with_request(request)
            .await;
    }
    for attempt in 0..3 {
        // An exception can break a stub; never reuse it for a retry.
        let stub = namespace
            .id_from_name(name)?
            .get_stub()?
            .into_rpc::<RepositoryStub>();
        let result = match stub.fetch_request(request.clone()?.inner()) {
            Ok(promise) => JsFuture::from(promise).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(response) => return Ok(response.dyn_into::<web_sys::Response>()?.into()),
            Err(error) if attempt < 2 && retryable(&error) => {
                Delay::from(Duration::from_millis(100 << attempt)).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
    unreachable!()
}

fn retryable(error: &JsValue) -> bool {
    let flag = |name: &str| {
        js_sys::Reflect::get(error, &JsValue::from_str(name))
            .ok()?
            .as_bool()
    };
    if flag("overloaded") == Some(true)
        || flag("remote") == Some(true)
        || flag("retryable") == Some(false)
    {
        return false;
    }
    if flag("retryable") == Some(true) {
        return true;
    }
    // Older platform errors omit flags but include this diagnostic reference.
    let Some(error) = error.dyn_ref::<js_sys::Error>() else {
        return false;
    };
    let message: String = error.message().into();
    message
        .strip_prefix("internal error; reference = ")
        .is_some_and(|reference| {
            !reference.is_empty() && reference.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}
