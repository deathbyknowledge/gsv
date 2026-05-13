//! Pure helpers for AT Protocol handle, DID, and Lexicon resolution.

use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ResolverError {
    #[error("handle must be lowercase")]
    HandleNotLowercase,

    #[error("handle must contain at least two labels")]
    HandleTooFewLabels,

    #[error("handle must be at most 253 bytes")]
    HandleTooLong,

    #[error("handle contains an empty label")]
    EmptyHandleLabel,

    #[error("handle label `{0}` is too long")]
    HandleLabelTooLong(String),

    #[error("handle label `{0}` contains invalid characters")]
    InvalidHandleLabel(String),

    #[error("handle label `{0}` must not start or end with hyphen")]
    InvalidHandleHyphen(String),

    #[error("handle top-level domain `{0}` is reserved")]
    ReservedHandleTld(String),

    #[error("handle top-level domain `{0}` must not start with a digit")]
    HandleTldStartsWithDigit(String),

    #[error("unsupported DID method `{0}`")]
    UnsupportedDidMethod(String),

    #[error("did:web identifier is empty")]
    EmptyDidWeb,

    #[error("did:web host is not a valid handle")]
    InvalidDidWebHost,

    #[error("DID document is missing id `{0}`")]
    DidDocumentIdMismatch(String),

    #[error("invalid Lexicon authority override `{0}`: expected authority.domain=did")]
    InvalidLexiconAuthorityOverride(String),
}

pub fn validate_handle_syntax(handle: &str) -> Result<(), ResolverError> {
    if handle != handle.to_ascii_lowercase() {
        return Err(ResolverError::HandleNotLowercase);
    }
    if handle.len() > 253 {
        return Err(ResolverError::HandleTooLong);
    }
    let labels = handle.split('.').collect::<Vec<_>>();
    if labels.len() < 2 {
        return Err(ResolverError::HandleTooFewLabels);
    }
    for label in &labels {
        validate_handle_label(label)?;
    }
    let tld = labels.last().copied().unwrap_or_default();
    if tld.bytes().next().is_some_and(|byte| byte.is_ascii_digit()) {
        return Err(ResolverError::HandleTldStartsWithDigit(tld.to_string()));
    }
    if is_reserved_tld(tld) {
        return Err(ResolverError::ReservedHandleTld(tld.to_string()));
    }
    Ok(())
}

fn validate_handle_label(label: &str) -> Result<(), ResolverError> {
    if label.is_empty() {
        return Err(ResolverError::EmptyHandleLabel);
    }
    if label.len() > 63 {
        return Err(ResolverError::HandleLabelTooLong(label.to_string()));
    }
    if label.starts_with('-') || label.ends_with('-') {
        return Err(ResolverError::InvalidHandleHyphen(label.to_string()));
    }
    if !label
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ResolverError::InvalidHandleLabel(label.to_string()));
    }
    Ok(())
}

fn is_reserved_tld(tld: &str) -> bool {
    matches!(
        tld,
        "alt"
            | "arpa"
            | "example"
            | "internal"
            | "invalid"
            | "local"
            | "localhost"
            | "onion"
            | "test"
    )
}

pub fn handle_did_txt_name(handle: &str) -> String {
    format!("_atproto.{handle}")
}

pub fn lexicon_txt_name(collection: &str) -> Option<String> {
    lexicon_authority_domain(collection).map(|domain| format!("_lexicon.{domain}"))
}

pub fn lexicon_authority_did_override(
    config: &str,
    authority_domain: &str,
) -> Result<Option<String>, ResolverError> {
    for raw_entry in config.split([',', '\n']) {
        let entry = raw_entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((domain, did)) = entry.split_once('=') else {
            return Err(ResolverError::InvalidLexiconAuthorityOverride(
                entry.to_string(),
            ));
        };
        let domain = domain.trim().trim_start_matches("_lexicon.");
        let did = did.trim();
        if did.is_empty() {
            return Err(ResolverError::InvalidLexiconAuthorityOverride(
                entry.to_string(),
            ));
        }
        if domain == "*" || domain.eq_ignore_ascii_case(authority_domain) {
            return Ok(Some(did.to_string()));
        }
    }
    Ok(None)
}

pub fn lexicon_authority_domain(collection: &str) -> Option<String> {
    let labels = collection.split('.').collect::<Vec<_>>();
    if labels.len() < 3 || labels.iter().any(|label| label.is_empty()) {
        return None;
    }
    let authority = &labels[..labels.len() - 1];
    Some(
        authority
            .iter()
            .rev()
            .copied()
            .collect::<Vec<_>>()
            .join("."),
    )
}

pub fn did_web_document_url(did: &str) -> Result<String, ResolverError> {
    let Some(method_specific) = did.strip_prefix("did:web:") else {
        let method = did
            .strip_prefix("did:")
            .and_then(|rest| rest.split(':').next())
            .unwrap_or_default()
            .to_string();
        return Err(ResolverError::UnsupportedDidMethod(method));
    };
    if method_specific.is_empty() {
        return Err(ResolverError::EmptyDidWeb);
    }

    let parts = method_specific.split(':').collect::<Vec<_>>();
    let host = parts[0].replace("%3A", ":").replace("%3a", ":");
    if validate_handle_syntax(&host).is_err() {
        return Err(ResolverError::InvalidDidWebHost);
    }
    if parts.len() == 1 {
        Ok(format!("https://{host}/.well-known/did.json"))
    } else {
        let path = parts[1..].join("/");
        Ok(format!("https://{host}/{path}/did.json"))
    }
}

pub fn dns_txt_value(data: &str) -> String {
    let mut out = String::new();
    let mut in_quote = false;
    let mut escaped = false;
    let mut saw_quote = false;

    for ch in data.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_quote => escaped = true,
            '"' => {
                saw_quote = true;
                in_quote = !in_quote;
            }
            _ if in_quote => out.push(ch),
            _ if !saw_quote && !ch.is_whitespace() => out.push(ch),
            _ => {}
        }
    }

    out
}

pub fn prefixed_txt_value(records: &[String], prefix: &str) -> Option<String> {
    prefixed_txt_values(records, prefix).into_iter().next()
}

pub fn prefixed_txt_values(records: &[String], prefix: &str) -> Vec<String> {
    records
        .iter()
        .map(|record| dns_txt_value(record))
        .filter_map(|record| record.strip_prefix(prefix).map(ToString::to_string))
        .collect()
}

pub fn did_document_has_id(doc: &Value, did: &str) -> bool {
    doc.get("id").and_then(Value::as_str) == Some(did)
}

pub fn did_document_claims_handle(doc: &Value, handle: &str) -> bool {
    let expected = format!("at://{handle}");
    doc.get("alsoKnownAs")
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(&expected)))
}

pub fn did_document_pds_endpoint(doc: &Value) -> Option<String> {
    doc.get("service")
        .and_then(Value::as_array)?
        .iter()
        .find(|service| {
            service.get("type").and_then(Value::as_str) == Some("AtprotoPersonalDataServer")
        })
        .and_then(|service| service.get("serviceEndpoint").and_then(Value::as_str))
        .filter(|endpoint| endpoint.starts_with("https://"))
        .map(|endpoint| endpoint.trim_end_matches('/').to_string())
}

pub fn did_document_public_key_multibase(doc: &Value, fragment: &str) -> Option<String> {
    doc.get("verificationMethod")
        .and_then(Value::as_array)?
        .iter()
        .find(|method| {
            method.get("id").and_then(Value::as_str).is_some_and(|id| {
                id == format!("#{fragment}") || id.ends_with(&format!("#{fragment}"))
            })
        })
        .and_then(|method| method.get("publicKeyMultibase").and_then(Value::as_str))
        .map(ToString::to_string)
}

pub fn ensure_did_document_id(doc: &Value, did: &str) -> Result<(), ResolverError> {
    if did_document_has_id(doc, did) {
        Ok(())
    } else {
        Err(ResolverError::DidDocumentIdMismatch(did.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_handle_syntax() {
        assert!(validate_handle_syntax("gsv-pds.stevej.workers.dev").is_ok());
        assert_eq!(
            validate_handle_syntax("GSV.example.com"),
            Err(ResolverError::HandleNotLowercase)
        );
        assert_eq!(
            validate_handle_syntax("localhost"),
            Err(ResolverError::HandleTooFewLabels)
        );
        assert_eq!(
            validate_handle_syntax("bad-.example.com"),
            Err(ResolverError::InvalidHandleHyphen("bad-".to_string()))
        );
        assert_eq!(
            validate_handle_syntax("bad_label.example.com"),
            Err(ResolverError::InvalidHandleLabel("bad_label".to_string()))
        );
        assert_eq!(
            validate_handle_syntax("john.0"),
            Err(ResolverError::HandleTldStartsWithDigit("0".to_string()))
        );
        assert_eq!(
            validate_handle_syntax("example.test"),
            Err(ResolverError::ReservedHandleTld("test".to_string()))
        );
    }

    #[test]
    fn builds_did_web_document_urls() {
        assert_eq!(
            did_web_document_url("did:web:example.com").unwrap(),
            "https://example.com/.well-known/did.json"
        );
        assert_eq!(
            did_web_document_url("did:web:example.com:user:alice").unwrap(),
            "https://example.com/user/alice/did.json"
        );
        assert_eq!(
            did_web_document_url("did:plc:abc"),
            Err(ResolverError::UnsupportedDidMethod("plc".to_string()))
        );
    }

    #[test]
    fn parses_doh_txt_values() {
        assert_eq!(dns_txt_value("\"did=did:plc:abc\""), "did=did:plc:abc");
        assert_eq!(
            dns_txt_value("\"did=did:web:\" \"example.com\""),
            "did=did:web:example.com"
        );
        assert_eq!(
            dns_txt_value("did=did:web:example.com"),
            "did=did:web:example.com"
        );
    }

    #[test]
    fn finds_prefixed_txt_values() {
        let records = vec![
            "\"other=value\"".to_string(),
            "\"did=did:web:example.com\"".to_string(),
        ];
        assert_eq!(
            prefixed_txt_value(&records, "did="),
            Some("did:web:example.com".to_string())
        );
    }

    #[test]
    fn derives_lexicon_authority_domain() {
        assert_eq!(
            lexicon_authority_domain("app.bsky.feed.post"),
            Some("feed.bsky.app".to_string())
        );
        assert_eq!(
            lexicon_authority_domain("com.example.note"),
            Some("example.com".to_string())
        );
        assert_eq!(lexicon_authority_domain("invalid"), None);
    }

    #[test]
    fn reads_lexicon_authority_did_overrides() {
        assert_eq!(
            lexicon_authority_did_override(
                "example.com=did:web:lex.example.com, gsv.app=did:web:gsv.example.com",
                "gsv.app",
            )
            .unwrap(),
            Some("did:web:gsv.example.com".to_string())
        );
        assert_eq!(
            lexicon_authority_did_override("*=did:web:default.example.com", "gsv.app").unwrap(),
            Some("did:web:default.example.com".to_string())
        );
        assert_eq!(
            lexicon_authority_did_override("example.com=did:web:lex.example.com", "gsv.app")
                .unwrap(),
            None
        );
        assert!(matches!(
            lexicon_authority_did_override("not-a-pair", "gsv.app"),
            Err(ResolverError::InvalidLexiconAuthorityOverride(_))
        ));
    }

    #[test]
    fn reads_did_doc_claims() {
        let doc = json!({
            "id": "did:web:example.com",
            "alsoKnownAs": ["at://example.com"],
            "service": [{
                "id": "#atproto_pds",
                "type": "AtprotoPersonalDataServer",
                "serviceEndpoint": "https://pds.example.com/"
            }],
            "verificationMethod": [{
                "id": "did:web:example.com#atproto",
                "type": "Multikey",
                "controller": "did:web:example.com",
                "publicKeyMultibase": "zDnaep6nVw4hkSuHnNTRmH5Wd6s2NN9UFLjssSJWvo8DqX6tf"
            }]
        });

        assert!(did_document_has_id(&doc, "did:web:example.com"));
        assert!(did_document_claims_handle(&doc, "example.com"));
        assert_eq!(
            did_document_pds_endpoint(&doc),
            Some("https://pds.example.com".to_string())
        );
        assert_eq!(
            did_document_public_key_multibase(&doc, "atproto").as_deref(),
            Some("zDnaep6nVw4hkSuHnNTRmH5Wd6s2NN9UFLjssSJWvo8DqX6tf")
        );
    }
}
