//! Record validation against AT Protocol Lexicon documents.

use std::collections::BTreeSet;

use serde_json::Value;
use thiserror::Error;

pub const LEXICON_SCHEMA_COLLECTION: &str = "com.atproto.lexicon.schema";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordValidationStatus {
    Valid,
    Unknown,
}

impl RecordValidationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Error)]
pub enum RecordValidationError {
    #[error("Lexicon `{collection}` is not known locally")]
    UnknownLexicon { collection: String },

    #[error("record failed Lexicon validation: {0}")]
    InvalidRecord(String),

    #[error("Lexicon schema failed validation: {0}")]
    InvalidLexicon(String),
}

pub fn validate_record(
    collection: &str,
    record: &Value,
    explicit: bool,
) -> Result<RecordValidationStatus, RecordValidationError> {
    validate_record_with_lexicons(collection, record, explicit, &[])
}

pub fn validate_record_with_lexicons(
    collection: &str,
    record: &Value,
    explicit: bool,
    extra_lexicons: &[Value],
) -> Result<RecordValidationStatus, RecordValidationError> {
    let lexicons = extra_lexicons.to_vec();
    if !lexicons
        .iter()
        .any(|lexicon| lexicon.get("id").and_then(Value::as_str) == Some(collection))
    {
        return if explicit {
            Err(RecordValidationError::UnknownLexicon {
                collection: collection.to_string(),
            })
        } else {
            Ok(RecordValidationStatus::Unknown)
        };
    };

    slices_lexicon::validate_record(lexicons, collection, record.clone())
        .map_err(|error| RecordValidationError::InvalidRecord(error.to_string()))?;
    Ok(RecordValidationStatus::Valid)
}

pub fn validate_lexicon_schema(lexicon: &Value) -> Result<(), RecordValidationError> {
    slices_lexicon::validate(vec![normalize_schema_record(lexicon)?])
        .map_err(|error| RecordValidationError::InvalidLexicon(format!("{error:?}")))
}

pub fn normalize_schema_record(lexicon: &Value) -> Result<Value, RecordValidationError> {
    let mut lexicon = lexicon.clone();
    let Some(object) = lexicon.as_object_mut() else {
        return Err(RecordValidationError::InvalidLexicon(
            "Lexicon schema must be a JSON object".to_string(),
        ));
    };
    object.remove("$type");
    Ok(lexicon)
}

pub fn published_schema_record(lexicon: &Value) -> Result<Value, RecordValidationError> {
    let mut record = normalize_schema_record(lexicon)?;
    let Some(object) = record.as_object_mut() else {
        return Err(RecordValidationError::InvalidLexicon(
            "Lexicon schema must be a JSON object".to_string(),
        ));
    };
    object.insert(
        "$type".to_string(),
        Value::String(LEXICON_SCHEMA_COLLECTION.to_string()),
    );
    Ok(record)
}

pub fn schema_id(lexicon: &Value) -> Option<&str> {
    lexicon.get("id").and_then(Value::as_str)
}

pub fn bundled_space_gsv_lexicons() -> Vec<Value> {
    vec![
        serde_json::from_str(include_str!("../lexicons/space.gsv.profile.json")).unwrap(),
        serde_json::from_str(include_str!("../lexicons/space.gsv.instance.json")).unwrap(),
        serde_json::from_str(include_str!("../lexicons/space.gsv.user.json")).unwrap(),
        serde_json::from_str(include_str!("../lexicons/space.gsv.contact.json")).unwrap(),
        serde_json::from_str(include_str!("../lexicons/space.gsv.package.json")).unwrap(),
        serde_json::from_str(include_str!("../lexicons/space.gsv.package.release.json")).unwrap(),
        serde_json::from_str(include_str!("../lexicons/space.gsv.vouch.json")).unwrap(),
        serde_json::from_str(include_str!("../lexicons/space.gsv.news.json")).unwrap(),
    ]
}

pub fn referenced_lexicon_ids(lexicon: &Value) -> BTreeSet<String> {
    let mut refs = BTreeSet::new();
    collect_referenced_lexicon_ids(lexicon, &mut refs);
    if let Some(id) = lexicon.get("id").and_then(Value::as_str) {
        refs.remove(id);
    }
    refs
}

fn collect_referenced_lexicon_ids(value: &Value, refs: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(reference) = object.get("ref").and_then(Value::as_str) {
                insert_reference_nsid(reference, refs);
            }
            if let Some(references) = object.get("refs").and_then(Value::as_array) {
                for reference in references.iter().filter_map(Value::as_str) {
                    insert_reference_nsid(reference, refs);
                }
            }
            for value in object.values() {
                collect_referenced_lexicon_ids(value, refs);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_referenced_lexicon_ids(value, refs);
            }
        }
        _ => {}
    }
}

fn insert_reference_nsid(reference: &str, refs: &mut BTreeSet<String>) {
    let nsid = reference.split('#').next().unwrap_or(reference);
    if nsid.contains('.') && !nsid.is_empty() {
        refs.insert(nsid.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn handles_unknown_lexicons_by_validation_mode() {
        assert_eq!(
            validate_record(
                "app.unknown.record",
                &json!({"$type": "app.unknown.record"}),
                false,
            )
            .unwrap(),
            RecordValidationStatus::Unknown
        );
        assert!(matches!(
            validate_record(
                "app.unknown.record",
                &json!({"$type": "app.unknown.record"}),
                true,
            ),
            Err(RecordValidationError::UnknownLexicon { .. })
        ));
    }

    #[test]
    fn validates_extra_lexicons() {
        let extra = vec![test_note_lexicon()];

        assert_eq!(
            validate_record_with_lexicons(
                "app.extra.note",
                &json!({"$type": "app.extra.note", "body": "hello"}),
                true,
                &extra,
            )
            .unwrap(),
            RecordValidationStatus::Valid
        );
    }

    #[test]
    fn validates_lexicon_schema_documents() {
        validate_lexicon_schema(&test_note_lexicon()).unwrap();
        validate_lexicon_schema(&published_schema_record(&test_note_lexicon()).unwrap()).unwrap();
        let error = validate_lexicon_schema(&json!({
            "lexicon": 1,
            "id": "app.extra.broken",
            "defs": {
                "main": {
                    "type": "record"
                }
            }
        }))
        .unwrap_err();

        assert!(error.to_string().contains("Lexicon schema"));
    }

    #[test]
    fn validates_space_gsv_lexicons_and_sample_records() {
        for (collection, lexicon, sample) in space_gsv_samples() {
            validate_lexicon_schema(&lexicon).unwrap();
            validate_lexicon_schema(&published_schema_record(&lexicon).unwrap()).unwrap();
            assert_eq!(schema_id(&lexicon), Some(collection));
            assert_eq!(
                validate_record_with_lexicons(collection, &sample, true, &[lexicon]).unwrap(),
                RecordValidationStatus::Valid
            );
        }
    }

    #[test]
    fn bundles_space_gsv_lexicons_for_runtime_validation() {
        let lexicons = bundled_space_gsv_lexicons();
        assert!(lexicons
            .iter()
            .any(|lexicon| schema_id(lexicon) == Some("space.gsv.instance")));
        assert!(lexicons
            .iter()
            .any(|lexicon| schema_id(lexicon) == Some("space.gsv.news")));
        assert!(validate_record_with_lexicons(
            "space.gsv.instance",
            &json!({
                "$type": "space.gsv.instance",
                "createdAt": "2026-05-12T12:00:00Z",
                "endpoint": "https://gsv.example/social",
                "protocolVersion": 1,
                "serviceKey": {
                    "id": "did:web:gsv.example#service-key",
                    "type": "Multikey",
                    "publicKeyMultibase": "z6MkiGSVServiceKey"
                },
                "acceptedSocialMethods": ["social.message.status.update"]
            }),
            true,
            &lexicons,
        )
        .is_ok());
    }

    #[test]
    fn normalizes_and_publishes_schema_records() {
        let published = published_schema_record(&test_note_lexicon()).unwrap();
        assert_eq!(
            published.get("$type").and_then(Value::as_str),
            Some(LEXICON_SCHEMA_COLLECTION)
        );
        let normalized = normalize_schema_record(&published).unwrap();
        assert!(normalized.get("$type").is_none());
        assert_eq!(schema_id(&normalized), Some("app.extra.note"));
    }

    #[test]
    fn extracts_referenced_lexicon_ids() {
        let refs = referenced_lexicon_ids(&json!({
            "lexicon": 1,
            "id": "app.extra.note",
            "defs": {
                "main": {
                    "type": "record",
                    "key": "any",
                    "record": {
                        "type": "object",
                        "properties": {
                            "author": {
                                "type": "ref",
                                "ref": "app.extra.defs#author"
                            },
                            "embed": {
                                "type": "union",
                                "refs": ["app.extra.embed#main", "app.extra.note#main"]
                            }
                        }
                    }
                }
            }
        }));

        assert_eq!(
            refs.into_iter().collect::<Vec<_>>(),
            vec!["app.extra.defs".to_string(), "app.extra.embed".to_string()]
        );
    }

    fn test_note_lexicon() -> Value {
        json!({
            "lexicon": 1,
            "id": "app.extra.note",
            "defs": {
                "main": {
                    "type": "record",
                    "key": "any",
                    "record": {
                        "type": "object",
                        "required": ["$type", "body"],
                        "properties": {
                            "$type": { "type": "string", "const": "app.extra.note" },
                            "body": { "type": "string", "maxLength": 64 }
                        }
                    }
                }
            }
        })
    }

    fn space_gsv_samples() -> Vec<(&'static str, Value, Value)> {
        vec![
            (
                "space.gsv.profile",
                serde_json::from_str(include_str!("../lexicons/space.gsv.profile.json")).unwrap(),
                json!({
                    "$type": "space.gsv.profile",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "updatedAt": "2026-05-12T12:01:00Z",
                    "displayName": "Hank",
                    "description": "GSV builder",
                    "avatar": {
                        "$type": "blob",
                        "ref": {"$link": "bafkreibm6jgkwx5ztbnodjrbazecinj63znepv3izjrb6ztscgzaemkhti"},
                        "mimeType": "image/png",
                        "size": 67
                    },
                    "avatarAlt": "profile image",
                    "links": [{"label": "GSV", "uri": "https://gsv.space"}]
                }),
            ),
            (
                "space.gsv.instance",
                serde_json::from_str(include_str!("../lexicons/space.gsv.instance.json")).unwrap(),
                json!({
                    "$type": "space.gsv.instance",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "endpoint": "https://gsv.example/social",
                    "protocolVersion": 1,
                    "serviceKey": {
                        "id": "did:web:gsv.example#service-key",
                        "type": "Multikey",
                        "publicKeyMultibase": "z6MkiGSVServiceKey"
                    },
                    "acceptedSocialMethods": [
                        "social.profile.read",
                        "social.user.read",
                        "social.contact.read",
                        "social.package.read",
                        "social.package.release.read",
                        "social.vouch.read",
                        "social.news.read",
                        "social.message.send",
                        "social.message.status.update"
                    ]
                }),
            ),
            (
                "space.gsv.user",
                serde_json::from_str(include_str!("../lexicons/space.gsv.user.json")).unwrap(),
                json!({
                    "$type": "space.gsv.user",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "updatedAt": "2026-05-12T12:01:00Z",
                    "username": "alice",
                    "displayName": "Alice",
                    "description": "Example resident.",
                    "publicHandle": "alice.example.com",
                    "acceptsContact": true
                }),
            ),
            (
                "space.gsv.contact",
                serde_json::from_str(include_str!("../lexicons/space.gsv.contact.json")).unwrap(),
                json!({
                    "$type": "space.gsv.contact",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "subject": {
                        "did": "did:web:alice.example.com",
                        "handle": "alice.example.com",
                        "uri": "at://did:web:alice.example.com/space.gsv.profile/self"
                    },
                    "label": "Alice",
                    "tags": ["collaborator"]
                }),
            ),
            (
                "space.gsv.package",
                serde_json::from_str(include_str!("../lexicons/space.gsv.package.json")).unwrap(),
                json!({
                    "$type": "space.gsv.package",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "name": "notes",
                    "displayName": "Notes",
                    "description": "A note-taking package.",
                    "source": {
                        "repo": "theagentscompany/gsv",
                        "ref": "main",
                        "subdir": "builtin-packages/notes",
                        "uri": "https://github.com/theagentscompany/gsv/tree/main/builtin-packages/notes"
                    },
                    "homepage": "https://gsv.space/packages/notes",
                    "tags": ["notes"]
                }),
            ),
            (
                "space.gsv.package.release",
                serde_json::from_str(include_str!("../lexicons/space.gsv.package.release.json"))
                    .unwrap(),
                json!({
                    "$type": "space.gsv.package.release",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "package": {
                        "uri": "at://did:web:gsv.example/space.gsv.package/notes"
                    },
                    "version": "1.0.0",
                    "title": "Initial release",
                    "description": "First public release.",
                    "source": {
                        "repo": "theagentscompany/gsv",
                        "ref": "main",
                        "subdir": "builtin-packages/notes"
                    },
                    "releasedAt": "2026-05-12T12:00:00Z",
                    "tags": ["release"]
                }),
            ),
            (
                "space.gsv.vouch",
                serde_json::from_str(include_str!("../lexicons/space.gsv.vouch.json")).unwrap(),
                json!({
                    "$type": "space.gsv.vouch",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "subject": {
                        "uri": "at://did:web:gsv.example/space.gsv.package/notes",
                        "cid": "bafkreibm6jgkwx5ztbnodjrbazecinj63znepv3izjrb6ztscgzaemkhti"
                    },
                    "note": "Useful package.",
                    "tags": ["trusted"]
                }),
            ),
            (
                "space.gsv.news",
                serde_json::from_str(include_str!("../lexicons/space.gsv.news.json")).unwrap(),
                json!({
                    "$type": "space.gsv.news",
                    "createdAt": "2026-05-12T12:00:00Z",
                    "title": "Notes release",
                    "text": "Notes 1.0.0 is available.",
                    "tags": ["package", "release"],
                    "startsAt": "2026-05-12T12:00:00Z",
                    "endsAt": "2026-05-13T12:00:00Z",
                    "subjects": [
                        {
                            "uri": "at://did:web:gsv.example/space.gsv.package.release/3kqonw7e3fs2a"
                        }
                    ]
                }),
            ),
        ]
    }
}
