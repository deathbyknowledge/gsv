//! An error that escapes a request boundary leaves ripgit as one answer the caller can quote,
//! one logged cause, and, when the deployment enables telemetry, one closed record that names
//! neither the cause nor the repository.

use serde_json::{json, Value};
use worker::wasm_bindgen::prelude::wasm_bindgen;
use worker::*;

/// The owning caller keeps this much of the cause; the logged cause is complete.
const MESSAGE_LIMIT: usize = 1024;

#[wasm_bindgen(wasm_bindgen = worker::wasm_bindgen)]
extern "C" {
    #[wasm_bindgen(js_namespace = crypto, js_name = randomUUID)]
    fn random_uuid() -> String;
}

/// Which layer reported the failure, from the error's workers-rs variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// The Workers runtime: storage, Durable Object calls and request bodies.
    Runtime,
    /// ripgit's own refusals and invariants.
    Repository,
    Json,
    Encoding,
    Binding,
    Other,
}

impl FailureKind {
    #[cfg(test)]
    const ALL: [Self; 6] = [
        Self::Runtime,
        Self::Repository,
        Self::Json,
        Self::Encoding,
        Self::Binding,
        Self::Other,
    ];

    fn of(error: &Error) -> Self {
        match error {
            Error::JsError(_) | Error::Internal(_) => Self::Runtime,
            Error::RustError(_) => Self::Repository,
            Error::Json(_) | Error::SerdeJsonError(_) | Error::SerdeWasmBindgenError(_) => {
                Self::Json
            }
            Error::BadEncoding | Error::Utf8Error(_) => Self::Encoding,
            Error::BindingError(_) => Self::Binding,
            _ => Self::Other,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Repository => "repository",
            Self::Json => "json",
            Self::Encoding => "encoding",
            Self::Binding => "binding",
            Self::Other => "other",
        }
    }
}

/// The operation that failed, without the repository it addressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Apply,
    Import,
    HyperspaceRead,
    Read,
    GitInfoRefs,
    GitUploadPack,
    GitReceivePack,
    Admin,
    Delete,
    Registration,
    Lifecycle,
    Discovery,
    Other,
}

impl Route {
    #[cfg(test)]
    const ALL: [Self; 13] = [
        Self::Apply,
        Self::Import,
        Self::HyperspaceRead,
        Self::Read,
        Self::GitInfoRefs,
        Self::GitUploadPack,
        Self::GitReceivePack,
        Self::Admin,
        Self::Delete,
        Self::Registration,
        Self::Lifecycle,
        Self::Discovery,
        Self::Other,
    ];

    /// Classifies both the Worker's paths and the paths it forwards to a Repository object.
    pub fn of(method: &Method, path: &str) -> Self {
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match parts.as_slice() {
            [".gsv", "discovery", ..]
            | [".gsv", "index", "import"]
            | [".gsv", "resource", "inspect"] => Self::Discovery,
            [".gsv", "index", "register"] => Self::Registration,
            [".gsv", ..] => Self::Lifecycle,
            ["hyperspace", "repos", _, _, action, ..] | [_, _, "hyperspace", action, ..] => {
                match *action {
                    "apply" => Self::Apply,
                    "import" => Self::Import,
                    "read" | "refs" | "log" | "search" | "compare" => Self::HyperspaceRead,
                    _ => Self::Other,
                }
            }
            [_, _] | [_, _, ""] if *method == Method::Delete => Self::Delete,
            [_, _, "info", "refs"] => Self::GitInfoRefs,
            [_, _, "git-upload-pack"] => Self::GitUploadPack,
            [_, _, "git-receive-pack"] => Self::GitReceivePack,
            [_, _, "admin", ..] => Self::Admin,
            [_, _, "refs" | "file" | "search" | "stats" | "diff" | "compare" | "log" | "commit"
            | "tree" | "blob", ..] => Self::Read,
            _ => Self::Other,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::Import => "import",
            Self::HyperspaceRead => "hyperspace-read",
            Self::Read => "read",
            Self::GitInfoRefs => "git-info-refs",
            Self::GitUploadPack => "git-upload-pack",
            Self::GitReceivePack => "git-receive-pack",
            Self::Admin => "admin",
            Self::Delete => "delete",
            Self::Registration => "registration",
            Self::Lifecycle => "lifecycle",
            Self::Discovery => "discovery",
            Self::Other => "other",
        }
    }
}

/// Answers an error that escaped a request boundary. Telemetry needs the installation the
/// request was routed for; lifecycle and discovery requests without one are only logged.
pub fn answer(
    error: &Error,
    env: &Env,
    installation_id: Option<&str>,
    route: Route,
    started_at: u64,
) -> Result<Response> {
    let diagnostic_id = random_uuid();
    let kind = FailureKind::of(error);
    let (failure, diagnostic) = log_lines(route, kind, &diagnostic_id, error);
    console_error!("{failure}");
    console_log!("{diagnostic}");
    if let Some(installation_id) = installation_id.filter(|_| telemetry_enabled(env)) {
        let occurred_at = Date::now().as_millis();
        let record = telemetry_record(
            &random_uuid(),
            occurred_at,
            installation_id,
            &diagnostic_id,
            route,
            kind,
            occurred_at.saturating_sub(started_at),
        );
        // The operator's tail consumer reads a record as the single object argument of its log.
        if let Ok(record) = js_sys::JSON::parse(&record.to_string()) {
            web_sys::console::log_1(&record);
        }
    }
    Ok(Response::from_json(&json!({
        "error": "InternalError",
        "kind": kind.as_str(),
        "diagnosticId": diagnostic_id,
        "message": bounded(&error.to_string()),
    }))?
    .with_status(500))
}

/// The error line and the line after it. The diagnostic ID has a line of its own, because the
/// operator's tail fingerprints error lines: failures with the same cause then group together.
fn log_lines(
    route: Route,
    kind: FailureKind,
    diagnostic_id: &str,
    error: &Error,
) -> (String, String) {
    (
        format!(
            "[ripgit] {} failed ({} error): {error}",
            route.as_str(),
            kind.as_str()
        ),
        format!(
            "[ripgit] {} failure above has diagnostic {diagnostic_id}",
            route.as_str()
        ),
    )
}

/// Matches the Gateway's reading of the same deployment variable.
fn telemetry_enabled(env: &Env) -> bool {
    let value = js_sys::Reflect::get(env, &"GSV_TELEMETRY_ENABLED".into()).unwrap_or_default();
    value.as_bool() == Some(true)
        || value.as_f64() == Some(1.0)
        || value.as_string().as_deref() == Some("1")
}

fn telemetry_record(
    event_id: &str,
    occurred_at: u64,
    installation_id: &str,
    diagnostic_id: &str,
    route: Route,
    kind: FailureKind,
    duration_ms: u64,
) -> Value {
    json!({
        "marker": "gsv.telemetry",
        "version": 1,
        "eventId": event_id,
        "occurredAt": occurred_at,
        "installationId": installation_id,
        "component": "ripgit",
        "event": {
            "stream": "operational",
            "name": "ripgit.request.failed",
            "properties": {
                "diagnosticId": diagnostic_id,
                "outcome": "failed",
                "route": route.as_str(),
                "kind": kind.as_str(),
                "durationMs": duration_ms,
            },
        },
    })
}

fn bounded(message: &str) -> String {
    let mut end = message.len().min(MESSAGE_LIMIT);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vocabulary {
        kinds: Vec<String>,
        routes: Vec<String>,
    }

    fn vocabulary() -> Vocabulary {
        // The SDK's telemetry tests read the same file, so the two vocabularies cannot drift apart.
        serde_json::from_str(include_str!(
            "../../../packages/gsv/test/fixtures/ripgit-failure-vocabulary.json"
        ))
        .unwrap()
    }

    #[test]
    fn names_the_kinds_and_routes_the_telemetry_contract_allows() {
        let vocabulary = vocabulary();
        let kinds: Vec<&str> = FailureKind::ALL.iter().map(|kind| kind.as_str()).collect();
        let routes: Vec<&str> = Route::ALL.iter().map(|route| route.as_str()).collect();
        assert_eq!(kinds, vocabulary.kinds);
        assert_eq!(routes, vocabulary.routes);
    }

    #[test]
    fn classifies_errors_by_the_layer_that_reported_them() {
        let cases = [
            (Error::JsError("SQLITE_FULL".into()), FailureKind::Runtime),
            (
                Error::RustError("Installation is retired".into()),
                FailureKind::Repository,
            ),
            (
                Error::SerdeJsonError(serde_json::from_str::<u8>("x").unwrap_err()),
                FailureKind::Json,
            ),
            (Error::BadEncoding, FailureKind::Encoding),
            (
                Error::BindingError("REPOSITORY".into()),
                FailureKind::Binding,
            ),
            (Error::BodyUsed, FailureKind::Other),
        ];
        for (error, kind) in cases {
            assert_eq!(FailureKind::of(&error), kind, "{error}");
        }
    }

    #[test]
    fn classifies_worker_and_repository_object_paths_alike() {
        let cases = [
            (
                Method::Post,
                "/hyperspace/repos/alice/home/apply",
                Route::Apply,
            ),
            (Method::Post, "/alice/home/hyperspace/apply", Route::Apply),
            (Method::Post, "/alice/home/hyperspace/import", Route::Import),
            (
                Method::Get,
                "/hyperspace/repos/alice/home/refs",
                Route::HyperspaceRead,
            ),
            (
                Method::Get,
                "/alice/home/hyperspace/read",
                Route::HyperspaceRead,
            ),
            (Method::Get, "/alice/home/file", Route::Read),
            (Method::Get, "/alice/home/blob/abc", Route::Read),
            (Method::Get, "/alice/home/info/refs", Route::GitInfoRefs),
            (
                Method::Post,
                "/alice/home/git-upload-pack",
                Route::GitUploadPack,
            ),
            (
                Method::Post,
                "/alice/home/git-receive-pack",
                Route::GitReceivePack,
            ),
            (Method::Put, "/alice/home/admin/set-ref", Route::Admin),
            (Method::Delete, "/alice/home", Route::Delete),
            (Method::Get, "/alice/home", Route::Other),
            (Method::Post, "/.gsv/index/register", Route::Registration),
            (Method::Post, "/.gsv/installation/quiesce", Route::Lifecycle),
            (Method::Post, "/.gsv/index/erase", Route::Lifecycle),
            (Method::Post, "/.gsv/resource/quiesce", Route::Lifecycle),
            (Method::Post, "/.gsv/discovery/inspect", Route::Discovery),
            (Method::Post, "/.gsv/index/import", Route::Discovery),
            (Method::Get, "/.gsv/resource/inspect", Route::Discovery),
            (Method::Get, "/", Route::Other),
        ];
        for (method, path, route) in cases {
            assert_eq!(Route::of(&method, path), route, "{method:?} {path}");
        }
    }

    #[test]
    fn writes_the_closed_telemetry_record() {
        let record = telemetry_record(
            "22222222-2222-4222-8222-222222222222",
            1_761_350_400_000,
            "inst_ripgit",
            "11111111-1111-4111-8111-111111111111",
            Route::Apply,
            FailureKind::Repository,
            12,
        );
        assert_eq!(
            record,
            json!({
                "marker": "gsv.telemetry",
                "version": 1,
                "eventId": "22222222-2222-4222-8222-222222222222",
                "occurredAt": 1_761_350_400_000u64,
                "installationId": "inst_ripgit",
                "component": "ripgit",
                "event": {
                    "stream": "operational",
                    "name": "ripgit.request.failed",
                    "properties": {
                        "diagnosticId": "11111111-1111-4111-8111-111111111111",
                        "outcome": "failed",
                        "route": "apply",
                        "kind": "repository",
                        "durationMs": 12,
                    },
                },
            })
        );
    }

    #[test]
    fn logs_identical_failures_alike_and_their_diagnostics_apart() {
        let error = Error::JsError("SQLITE_FULL".into());
        let (first, first_diagnostic) = log_lines(
            Route::Apply,
            FailureKind::Runtime,
            "11111111-1111-4111-8111-111111111111",
            &error,
        );
        let (second, _) = log_lines(
            Route::Apply,
            FailureKind::Runtime,
            "22222222-2222-4222-8222-222222222222",
            &error,
        );
        assert_eq!(first, second);
        assert_eq!(first, "[ripgit] apply failed (runtime error): SQLITE_FULL");
        assert_eq!(
            first_diagnostic,
            "[ripgit] apply failure above has diagnostic 11111111-1111-4111-8111-111111111111"
        );
    }

    #[test]
    fn bounds_the_cause_on_a_character_boundary() {
        assert_eq!(
            bounded("Installation is retired"),
            "Installation is retired"
        );
        let long = format!("{}é", "a".repeat(MESSAGE_LIMIT - 1));
        assert_eq!(bounded(&long), "a".repeat(MESSAGE_LIMIT - 1));
    }
}
