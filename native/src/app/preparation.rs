use std::collections::HashMap;

use tokio::sync::{
    mpsc::{channel, Receiver, Sender},
    watch,
};

use crate::content::MediaAttachment;
use crate::model::{Moment, MomentRole, MomentState};
use crate::prepared::{
    content_revision, prepare_completed_assistant, prepare_literal_content, ContentRevision,
    PreparedContent,
};

const PREPARED_CONTENT_CACHE_LIMIT: usize = 64;
const PRELOAD_NEIGHBORS: usize = 12;
const PREPARATION_RESULT_CAPACITY: usize = PREPARED_CONTENT_CACHE_LIMIT;

#[derive(Clone)]
pub(super) struct ContentPreparationRequest {
    id: String,
    revision: ContentRevision,
    generation: u64,
    text: String,
    media: Vec<MediaAttachment>,
    mode: PreparationMode,
}

#[derive(Clone)]
pub(super) struct ContentPreparationBatch {
    requests: Vec<ContentPreparationRequest>,
}

pub(super) struct ContentPreparationResult {
    pub id: String,
    revision: ContentRevision,
    generation: u64,
    mode: PreparationMode,
    pub content: PreparedContent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreparationMode {
    Literal,
    Markdown,
    StreamingMedia,
}

enum PreparedEntryState {
    Pending {
        generation: u64,
        fallback: Option<PreparedContent>,
    },
    Ready(PreparedContent),
}

struct PreparedEntry {
    revision: ContentRevision,
    mode: PreparationMode,
    last_used: u64,
    state: PreparedEntryState,
}

struct PreparationCandidate {
    id: String,
    revision: ContentRevision,
    text: String,
    media: Vec<MediaAttachment>,
    mode: PreparationMode,
}

pub(super) struct PreparedContentCache {
    entries: HashMap<String, PreparedEntry>,
    requests: watch::Sender<Option<ContentPreparationBatch>>,
    clock: u64,
    generation: u64,
    selected_request_id: Option<String>,
}

impl PreparedContentCache {
    pub fn new() -> (
        Self,
        watch::Receiver<Option<ContentPreparationBatch>>,
        Sender<ContentPreparationResult>,
        Receiver<ContentPreparationResult>,
    ) {
        let (requests, request_receiver) = watch::channel(None);
        let (results, result_receiver) = channel(PREPARATION_RESULT_CAPACITY);
        (
            Self {
                entries: HashMap::new(),
                requests,
                clock: 0,
                generation: 0,
                selected_request_id: None,
            },
            request_receiver,
            results,
            result_receiver,
        )
    }

    pub fn resolve_or_request(
        &mut self,
        id: &str,
        role: MomentRole,
        state: MomentState,
        text: &str,
        media: &[MediaAttachment],
    ) -> Option<PreparedContent> {
        let (mode, revision) = preparation_identity(role, state, text, media)?;

        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self
            .entries
            .get_mut(id)
            .filter(|entry| entry.revision == revision && entry.mode == mode)
        {
            entry.last_used = self.clock;
            match &entry.state {
                PreparedEntryState::Ready(content) => return Some(content.clone()),
                PreparedEntryState::Pending { fallback, .. }
                    if self.selected_request_id.as_deref() == Some(id) =>
                {
                    return fallback.clone();
                }
                PreparedEntryState::Pending { .. } => {}
            }
        }

        let candidate = preparation_candidate(id, text, media, mode, revision);
        self.publish_batch(vec![candidate], id);
        self.entries.get(id).and_then(|entry| match &entry.state {
            PreparedEntryState::Pending { fallback, .. } => fallback.clone(),
            PreparedEntryState::Ready(content) => Some(content.clone()),
        })
    }

    pub fn preload(&mut self, moments: &[Moment], selected: usize) {
        if moments.is_empty() {
            return;
        }
        let selected = selected.min(moments.len() - 1);
        let mut candidates = Vec::new();
        for distance in 0..=PRELOAD_NEIGHBORS {
            let previous = selected.checked_sub(distance);
            let next = (distance > 0)
                .then(|| selected.checked_add(distance))
                .flatten()
                .filter(|index| *index < moments.len());
            for index in [previous, next].into_iter().flatten() {
                let moment = &moments[index];
                let Some((mode, revision)) =
                    preparation_identity(moment.role, moment.state, &moment.text, &moment.media)
                else {
                    continue;
                };
                let already_ready = self.entries.get(&moment.id).is_some_and(|entry| {
                    entry.revision == revision
                        && entry.mode == mode
                        && matches!(entry.state, PreparedEntryState::Ready(_))
                });
                if !already_ready {
                    candidates.push(preparation_candidate(
                        &moment.id,
                        &moment.text,
                        &moment.media,
                        mode,
                        revision,
                    ));
                }
            }
        }

        if !candidates.is_empty() {
            self.publish_batch(candidates, &moments[selected].id);
        }
    }

    pub fn accept(&mut self, result: ContentPreparationResult) -> bool {
        if result.content.revision() != result.revision {
            return false;
        }
        let Some(entry) = self.entries.get_mut(&result.id).filter(|entry| {
            entry.revision == result.revision
                && entry.mode == result.mode
                && matches!(
                    entry.state,
                    PreparedEntryState::Pending { generation, .. }
                        if generation == result.generation
                )
        }) else {
            return false;
        };
        entry.state = PreparedEntryState::Ready(result.content);
        true
    }

    pub fn appends_plain_text(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(|entry| {
            entry.mode == PreparationMode::StreamingMedia
                || matches!(
                    entry.state,
                    PreparedEntryState::Pending {
                        fallback: Some(_),
                        ..
                    }
                )
        })
    }

    pub fn is_pending(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|entry| matches!(entry.state, PreparedEntryState::Pending { .. }))
    }

    #[cfg(test)]
    pub fn is_ready(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|entry| matches!(entry.state, PreparedEntryState::Ready(_)))
    }

    fn publish_batch(&mut self, candidates: Vec<PreparationCandidate>, selected_id: &str) {
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        let mut requests = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            self.clock = self.clock.wrapping_add(1);
            self.evict_for(&candidate.id);
            let media_revision = content_revision("", &candidate.media);
            let fallback = (candidate.mode == PreparationMode::Markdown)
                .then(|| self.entries.get(&candidate.id))
                .flatten()
                .and_then(|entry| match &entry.state {
                    PreparedEntryState::Ready(content)
                        if entry.mode == PreparationMode::StreamingMedia
                            && content.revision() == media_revision =>
                    {
                        Some(content.clone())
                    }
                    PreparedEntryState::Pending {
                        fallback: Some(content),
                        ..
                    } if content.revision() == media_revision => Some(content.clone()),
                    _ => None,
                });
            self.entries.insert(
                candidate.id.clone(),
                PreparedEntry {
                    revision: candidate.revision,
                    mode: candidate.mode,
                    last_used: self.clock,
                    state: PreparedEntryState::Pending {
                        generation,
                        fallback,
                    },
                },
            );
            requests.push(ContentPreparationRequest {
                id: candidate.id,
                revision: candidate.revision,
                generation,
                text: candidate.text,
                media: candidate.media,
                mode: candidate.mode,
            });
        }
        self.selected_request_id = Some(selected_id.to_string());
        if self
            .requests
            .send(Some(ContentPreparationBatch { requests }))
            .is_err()
        {
            self.entries.retain(|_, entry| {
                !matches!(
                    entry.state,
                    PreparedEntryState::Pending {
                        generation: pending,
                        ..
                    } if pending == generation
                )
            });
            self.selected_request_id = None;
        }
    }

    fn evict_for(&mut self, incoming_id: &str) {
        if self.entries.len() < PREPARED_CONTENT_CACHE_LIMIT
            || self.entries.contains_key(incoming_id)
        {
            return;
        }
        if let Some(oldest) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(id, _)| id.clone())
        {
            self.entries.remove(&oldest);
        }
    }
}

fn preparation_identity(
    role: MomentRole,
    state: MomentState,
    text: &str,
    media: &[MediaAttachment],
) -> Option<(PreparationMode, ContentRevision)> {
    let mode = match (state, role, media.is_empty()) {
        (MomentState::Complete, MomentRole::Intelligence, _) => PreparationMode::Markdown,
        (MomentState::Complete, _, false) => PreparationMode::Literal,
        (MomentState::Streaming, MomentRole::Intelligence, false) => {
            PreparationMode::StreamingMedia
        }
        _ => return None,
    };
    let revision_text = if mode == PreparationMode::StreamingMedia {
        ""
    } else {
        text
    };
    Some((mode, content_revision(revision_text, media)))
}

fn preparation_candidate(
    id: &str,
    text: &str,
    media: &[MediaAttachment],
    mode: PreparationMode,
    revision: ContentRevision,
) -> PreparationCandidate {
    PreparationCandidate {
        id: id.to_string(),
        revision,
        text: if mode == PreparationMode::StreamingMedia {
            String::new()
        } else {
            text.to_string()
        },
        media: media.to_vec(),
        mode,
    }
}

pub(super) async fn run_preparation_worker(
    mut requests: watch::Receiver<Option<ContentPreparationBatch>>,
    results: Sender<ContentPreparationResult>,
) {
    while requests.changed().await.is_ok() {
        let Some(batch) = requests.borrow_and_update().clone() else {
            continue;
        };
        for request in batch.requests {
            let content = match request.mode {
                PreparationMode::Markdown => {
                    prepare_completed_assistant(request.text, request.media)
                }
                PreparationMode::Literal | PreparationMode::StreamingMedia => {
                    prepare_literal_content(request.text, request.media)
                }
            };
            if results
                .send(ContentPreparationResult {
                    id: request.id,
                    revision: request.revision,
                    generation: request.generation,
                    mode: request.mode,
                    content,
                })
                .await
                .is_err()
            {
                return;
            }
            if requests.has_changed().unwrap_or(false) {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moment(id: &str, text: &str) -> Moment {
        Moment::new(id, MomentRole::Intelligence, text)
    }

    fn image_media(key: &str) -> Vec<MediaAttachment> {
        vec![MediaAttachment {
            kind: crate::content::MediaKind::Image,
            mime_type: "image/png".to_string(),
            key: Some(key.to_string()),
            path: None,
            url: None,
            filename: None,
            size: None,
            duration: None,
            transcription: None,
            description: None,
        }]
    }

    fn result_for(request: ContentPreparationRequest) -> ContentPreparationResult {
        let content = match request.mode {
            PreparationMode::Markdown => prepare_completed_assistant(request.text, request.media),
            PreparationMode::Literal | PreparationMode::StreamingMedia => {
                prepare_literal_content(request.text, request.media)
            }
        };
        ContentPreparationResult {
            id: request.id,
            revision: request.revision,
            generation: request.generation,
            mode: request.mode,
            content,
        }
    }

    #[test]
    fn stale_preparation_cannot_replace_a_new_revision() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "old",
                &[],
            )
            .is_none());
        let old = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("old request");
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "new",
                &[],
            )
            .is_none());

        assert!(!cache.accept(result_for(old)));
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "new",
                &[],
            )
            .is_none());
    }

    #[test]
    fn preload_prioritizes_selected_content() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let moments = vec![moment("first", "one"), moment("selected", "two")];
        cache.preload(&moments, 1);

        let batch = requests
            .borrow_and_update()
            .clone()
            .expect("preparation batch");
        assert_eq!(batch.requests[0].id, "selected");
        assert_eq!(batch.requests[1].id, "first");
    }

    #[test]
    fn latest_selected_revision_replaces_queued_work() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        for revision in 0..100 {
            assert!(cache
                .resolve_or_request(
                    "assistant",
                    MomentRole::Intelligence,
                    MomentState::Complete,
                    &format!("revision {revision}"),
                    &[],
                )
                .is_none());
        }

        let batch = requests.borrow_and_update().clone().expect("latest batch");
        assert_eq!(batch.requests.len(), 1);
        assert_eq!(batch.requests[0].text, "revision 99");
    }

    #[test]
    fn streaming_media_prepares_once_then_upgrades_to_completed_markdown() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let media = image_media("result.png");
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Streaming,
                "**partial**",
                &media,
            )
            .is_none());
        let streaming = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("streaming media batch");
        assert_eq!(streaming.mode, PreparationMode::StreamingMedia);
        assert_eq!(streaming.text, "");
        assert!(cache.accept(result_for(streaming)));
        let prepared = cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Streaming,
                "**a later partial**",
                &media,
            )
            .expect("stable media should not reprepare for each text delta");
        assert_eq!(prepared.media().len(), 1);

        let fallback = cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "**finished**",
                &media,
            )
            .expect("streaming media should remain visible during Markdown preparation");
        assert_eq!(fallback.media().len(), 1);
        assert!(cache.appends_plain_text("assistant"));
        let mut completed = moment("assistant", "**finished**");
        completed.media = media.clone();
        cache.preload(&[completed], 0);
        let republished_fallback = cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "**finished**",
                &media,
            )
            .expect("republishing the same completion must retain live media");
        assert_eq!(republished_fallback.media().len(), 1);
        let batch = requests
            .borrow_and_update()
            .clone()
            .expect("completion batch");
        assert_eq!(batch.requests[0].mode, PreparationMode::Markdown);
        assert!(cache.accept(result_for(batch.requests[0].clone())));
        assert!(!cache.appends_plain_text("assistant"));
    }

    #[test]
    fn changed_completion_media_does_not_reuse_the_streaming_fallback() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let streaming_media = image_media("partial.png");
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Streaming,
                "partial",
                &streaming_media,
            )
            .is_none());
        let streaming = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("streaming media batch");
        assert!(cache.accept(result_for(streaming)));

        let completed_media = image_media("final.png");
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "finished",
                &completed_media,
            )
            .is_none());
        assert!(!cache.appends_plain_text("assistant"));
    }
}
