use anyhow::{anyhow, Context, Result};
use js_sys::{Function, Reflect, Uint8Array};
use wacore::net::{HttpClient, HttpRequest, HttpResponse};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

#[derive(Debug, Clone, Copy, Default)]
pub struct WorkerHttpClient;

unsafe impl Send for WorkerHttpClient {}
unsafe impl Sync for WorkerHttpClient {}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl HttpClient for WorkerHttpClient {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse> {
        let init = web_sys::RequestInit::new();
        init.set_method(&request.method);

        let headers = web_sys::Headers::new().map_err(js_error)?;
        for (key, value) in &request.headers {
            headers.append(key, value).map_err(js_error)?;
        }
        init.set_headers(&headers);

        if let Some(body) = request.body {
            let bytes = Uint8Array::from(body.as_slice());
            init.set_body(bytes.as_ref());
        }

        let req = web_sys::Request::new_with_str_and_init(&request.url, &init).map_err(js_error)?;
        let global = js_sys::global();
        let fetch = Reflect::get(&global, &JsValue::from_str("fetch"))
            .map_err(js_error)?
            .dyn_into::<Function>()
            .map_err(|_| anyhow!("global fetch is not callable"))?;
        let response = JsFuture::from(
            fetch
                .call1(&global, req.as_ref())
                .map_err(js_error)?
                .dyn_into::<js_sys::Promise>()
                .map_err(|_| anyhow!("fetch did not return a Promise"))?,
        )
        .await
        .map_err(js_error)?
        .dyn_into::<web_sys::Response>()
        .map_err(|_| anyhow!("fetch did not resolve to a Response"))?;

        let status_code = response.status();
        let body = JsFuture::from(response.array_buffer().map_err(js_error)?)
            .await
            .map_err(js_error)
            .context("read HTTP response body")?;
        let body = Uint8Array::new(&body).to_vec();
        Ok(HttpResponse { status_code, body })
    }
}

fn js_error(value: JsValue) -> anyhow::Error {
    if let Some(message) = value.as_string() {
        anyhow!(message)
    } else {
        anyhow!("{value:?}")
    }
}
