use js_sys::{Function, Promise, Reflect};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use wacore::runtime::{AbortHandle, Runtime};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

#[derive(Debug, Clone, Copy, Default)]
pub struct WorkerRuntime;

unsafe impl Send for WorkerRuntime {}
unsafe impl Sync for WorkerRuntime {}

impl WorkerRuntime {
    fn timeout_promise(duration: Duration) -> Promise {
        let timeout_ms = duration.as_millis().min(i32::MAX as u128) as i32;
        Promise::new(&mut move |resolve, _reject| {
            let fallback_resolve = resolve.clone();
            let callback = Closure::once(move || {
                let _ = resolve.call0(&JsValue::UNDEFINED);
            });
            let global = js_sys::global();
            if let Ok(set_timeout) = Reflect::get(&global, &JsValue::from_str("setTimeout"))
                .and_then(|value| value.dyn_into::<Function>().map_err(Into::into))
            {
                let _ = set_timeout.call2(
                    &global,
                    callback.as_ref().unchecked_ref(),
                    &JsValue::from(timeout_ms),
                );
            } else {
                let _ = fallback_resolve.call0(&JsValue::UNDEFINED);
            }
            callback.forget();
        })
    }

    fn resolved_promise() -> Promise {
        Promise::resolve(&JsValue::UNDEFINED)
    }
}

impl Runtime for WorkerRuntime {
    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + 'static>>) -> AbortHandle {
        wasm_bindgen_futures::spawn_local(future);
        AbortHandle::noop()
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()>>> {
        Box::pin(async move {
            let _ = JsFuture::from(Self::timeout_promise(duration)).await;
        })
    }

    fn spawn_blocking(&self, f: Box<dyn FnOnce() + 'static>) -> Pin<Box<dyn Future<Output = ()>>> {
        Box::pin(async move {
            f();
        })
    }

    fn yield_now(&self) -> Option<Pin<Box<dyn Future<Output = ()>>>> {
        Some(Box::pin(async move {
            let _ = JsFuture::from(Self::resolved_promise()).await;
        }))
    }

    fn yield_frequency(&self) -> u32 {
        1
    }
}
