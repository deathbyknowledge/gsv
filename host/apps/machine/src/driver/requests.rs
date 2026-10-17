use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gateway_client::protocol::RequestFrame;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct ActiveRequestState {
    accepting: bool,
    requests: HashMap<String, ActiveRequest>,
}

#[derive(Clone)]
pub(crate) struct ActiveRequests(Arc<Mutex<ActiveRequestState>>);

impl Default for ActiveRequests {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(ActiveRequestState {
            accepting: true,
            requests: HashMap::new(),
        })))
    }
}

struct ActiveRequest {
    cancellation: Arc<CancellationToken>,
}

#[derive(Deserialize)]
pub(crate) struct RequestCancel {
    pub(crate) id: String,
    pub(crate) reason: Option<String>,
}

impl ActiveRequests {
    pub(crate) fn register(&self, request: &RequestFrame) -> Arc<CancellationToken> {
        let cancellation = Arc::new(CancellationToken::new());
        let previous = {
            let mut state = self.0.lock().expect("active request mutex poisoned");
            if !state.accepting {
                cancellation.cancel();
                return cancellation;
            }
            state.requests.insert(
                request.id.clone(),
                ActiveRequest {
                    cancellation: cancellation.clone(),
                },
            )
        };
        if let Some(previous) = previous {
            Self::stop(previous);
        }
        cancellation
    }

    pub(crate) fn cancel(&self, cancellation: RequestCancel) -> bool {
        let Some(request) = self
            .0
            .lock()
            .expect("active request mutex poisoned")
            .requests
            .remove(&cancellation.id)
        else {
            return false;
        };
        let _reason = cancellation
            .reason
            .as_deref()
            .unwrap_or("Request cancelled");
        Self::stop(request);
        true
    }

    pub(crate) fn cancel_all(&self, _reason: &str) {
        let requests = {
            let mut state = self.0.lock().expect("active request mutex poisoned");
            state.accepting = false;
            state
                .requests
                .drain()
                .map(|(_, request)| request)
                .collect::<Vec<_>>()
        };
        for request in requests {
            Self::stop(request);
        }
    }

    fn stop(request: ActiveRequest) {
        request.cancellation.cancel();
    }

    /// Requests still being served, bodies included: work a service stop
    /// would cut off.
    pub(crate) fn in_flight(&self) -> usize {
        self.0
            .lock()
            .expect("active request mutex poisoned")
            .requests
            .len()
    }

    pub(crate) fn finish(&self, id: &str, cancellation: &Arc<CancellationToken>) {
        let mut state = self.0.lock().expect("active request mutex poisoned");
        if state
            .requests
            .get(id)
            .is_some_and(|request| Arc::ptr_eq(&request.cancellation, cancellation))
        {
            state.requests.remove(id);
        }
    }
}
