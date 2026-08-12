use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::Arc;

use tokio::sync::{
    mpsc::{channel, Receiver, Sender},
    watch,
};

use crate::content::MediaAttachment;
use crate::history::HistoryPreparationCandidate;
use crate::model::{MomentIdentityAdoption, MomentRole, MomentState};
use crate::prepared::{
    content_revision, prepare_completed_assistant_with_revision,
    prepare_literal_content_with_revision, ContentRevision, PreparedContent,
};

const PREPARED_CONTENT_CACHE_LIMIT: usize = 256;
const PREPARATION_RESULT_CAPACITY: usize = 1;

#[derive(Clone)]
pub(super) struct ContentPreparationRequest {
    id: String,
    revision: ContentRevision,
    generation: u64,
    text: Arc<str>,
    media: Arc<Vec<MediaAttachment>>,
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

/// A preparation result that became authoritative in the cache. `target_id` is the current
/// presentation owner, which may differ from the worker's request id after history adoption.
/// `replaced_fallback` is moved out of the pending entry so the presentation layer can transition
/// from precisely the content it had been displaying without retaining another cache copy.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ContentPreparationAcceptance {
    pub target_id: String,
    pub replaced_fallback: Option<PreparedContent>,
}

impl Deref for ContentPreparationAcceptance {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.target_id
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum PreparationMode {
    Literal,
    Markdown,
    StreamingMedia,
}

enum PreparedEntryState {
    Pending {
        generation: u64,
        fallback: Option<PreparedContent>,
        source: PreparationSource,
    },
    Ready(PreparedContent),
}

#[derive(Clone)]
struct PreparationSource {
    text: Arc<str>,
    media: Arc<Vec<MediaAttachment>>,
}

struct PreparedEntry {
    revision: ContentRevision,
    mode: PreparationMode,
    last_used: u64,
    state: PreparedEntryState,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PreparationResultIdentity {
    id: String,
    revision: ContentRevision,
    generation: u64,
    mode: PreparationMode,
}

struct PreparationCandidate {
    id: String,
    revision: ContentRevision,
    media_revision: ContentRevision,
    text: Arc<str>,
    media: Arc<Vec<MediaAttachment>>,
    mode: PreparationMode,
}

pub(super) struct PreparedContentCache {
    entries: HashMap<String, PreparedEntry>,
    result_adoptions: HashMap<PreparationResultIdentity, String>,
    requests: watch::Sender<Option<ContentPreparationBatch>>,
    clock: u64,
    generation: u64,
    selected_request_id: Option<String>,
    deferred_selected_request_id: Option<String>,
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
                result_adoptions: HashMap::new(),
                requests,
                clock: 0,
                generation: 0,
                selected_request_id: None,
                deferred_selected_request_id: None,
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
        let mut matching_pending = false;
        let mut pending_fallback = None;
        if let Some(entry) = self
            .entries
            .get_mut(id)
            .filter(|entry| entry.revision == revision && entry.mode == mode)
        {
            entry.last_used = self.clock;
            match &entry.state {
                PreparedEntryState::Ready(content) => return Some(content.clone()),
                PreparedEntryState::Pending { fallback, .. } => {
                    matching_pending = true;
                    pending_fallback = fallback.clone();
                }
            }
        }
        if matching_pending {
            if self.selected_request_id.as_deref() != Some(id) {
                self.publish_pending(id);
            }
            return pending_fallback;
        }

        let candidate = preparation_candidate(id, text, media, mode, revision);
        self.publish_candidates(vec![candidate], id);
        self.entries.get(id).and_then(|entry| match &entry.state {
            PreparedEntryState::Pending { fallback, .. } => fallback.clone(),
            PreparedEntryState::Ready(content) => Some(content.clone()),
        })
    }

    pub fn resolve_history(
        &mut self,
        candidate: &HistoryPreparationCandidate,
    ) -> Option<PreparedContent> {
        self.clock = self.clock.wrapping_add(1);
        let mut matching_pending = false;
        let mut content = None;
        if let Some(entry) = self.entries.get_mut(candidate.id.as_ref()).filter(|entry| {
            entry.revision == candidate.revision && entry.mode == PreparationMode::Markdown
        }) {
            entry.last_used = self.clock;
            match &entry.state {
                PreparedEntryState::Ready(prepared) => return Some(prepared.clone()),
                PreparedEntryState::Pending { fallback, .. } => {
                    matching_pending = true;
                    content = fallback.clone();
                }
            }
        }
        if matching_pending {
            if self.selected_request_id.as_deref() != Some(candidate.id.as_ref()) {
                self.publish_pending(&candidate.id);
            }
            return content;
        }

        self.publish_candidates(
            vec![PreparationCandidate {
                id: candidate.id.to_string(),
                revision: candidate.revision,
                media_revision: candidate.media_revision,
                text: candidate.text.clone(),
                media: candidate.media.clone(),
                mode: PreparationMode::Markdown,
            }],
            &candidate.id,
        );
        self.entries
            .get(candidate.id.as_ref())
            .and_then(|entry| match &entry.state {
                PreparedEntryState::Pending { fallback, .. } => fallback.clone(),
                PreparedEntryState::Ready(content) => Some(content.clone()),
            })
    }

    pub fn preload_history(
        &mut self,
        candidates: &[HistoryPreparationCandidate],
        selected_id: Option<&str>,
    ) {
        let Some(selected_id) =
            selected_id.or_else(|| candidates.last().map(|candidate| candidate.id.as_ref()))
        else {
            return;
        };
        let mut seen = HashSet::with_capacity(candidates.len());
        let candidates = candidates
            .iter()
            .filter(|candidate| seen.insert((candidate.id.clone(), candidate.revision)))
            .map(|candidate| PreparationCandidate {
                id: candidate.id.to_string(),
                revision: candidate.revision,
                media_revision: candidate.media_revision,
                text: candidate.text.clone(),
                media: candidate.media.clone(),
                mode: PreparationMode::Markdown,
            })
            .collect::<Vec<_>>();
        self.publish_candidates(candidates, selected_id);
    }

    /// Transfer preparation ownership across the verified transient-to-history identity handoff.
    /// Pending work keeps its generation and is not republished; an exact result alias lets the
    /// already-running old-id request finish directly into the durable entry.
    pub(super) fn adopt_identities(&mut self, adoptions: &[MomentIdentityAdoption]) -> usize {
        adoptions
            .iter()
            .filter(|adoption| self.adopt_identity(adoption))
            .count()
    }

    fn adopt_identity(&mut self, adoption: &MomentIdentityAdoption) -> bool {
        if adoption.transient_id == adoption.durable_id {
            return false;
        }
        let Some(mut source) = self.entries.remove(&adoption.transient_id) else {
            return false;
        };
        if !entry_matches_adoption(&source, adoption) {
            self.entries.insert(adoption.transient_id.clone(), source);
            return false;
        }

        self.clock = self.clock.wrapping_add(1);
        source.last_used = self.clock;
        let keep_existing = self
            .entries
            .get(&adoption.durable_id)
            .filter(|existing| existing.revision == source.revision && existing.mode == source.mode)
            .is_some_and(|existing| {
                matches!(&existing.state, PreparedEntryState::Ready(_))
                    || matches!(&source.state, PreparedEntryState::Pending { .. })
            });

        self.drop_result_adoptions_for(&adoption.transient_id);
        if !keep_existing {
            self.drop_result_adoptions_for(&adoption.durable_id);
            let pending_identity = match &source.state {
                PreparedEntryState::Pending { generation, .. } => Some(PreparationResultIdentity {
                    id: adoption.transient_id.clone(),
                    revision: source.revision,
                    generation: *generation,
                    mode: source.mode,
                }),
                PreparedEntryState::Ready(_) => None,
            };
            self.entries.insert(adoption.durable_id.clone(), source);
            if let Some(identity) = pending_identity {
                self.result_adoptions
                    .insert(identity, adoption.durable_id.clone());
            }
        }
        if self.selected_request_id.as_deref() == Some(adoption.transient_id.as_str()) {
            self.selected_request_id = Some(adoption.durable_id.clone());
        }
        if self.deferred_selected_request_id.as_deref() == Some(adoption.transient_id.as_str()) {
            self.deferred_selected_request_id = Some(adoption.durable_id.clone());
        }
        true
    }

    /// Publish a correlated result and return the current presentation id that owns it. An
    /// in-flight transient request may have been adopted by an authoritative history id.
    pub fn accept(
        &mut self,
        result: ContentPreparationResult,
    ) -> Option<ContentPreparationAcceptance> {
        if result.content.revision() != result.revision {
            return None;
        }
        let direct_match = self.entries.get(&result.id).is_some_and(|entry| {
            entry_accepts_result(entry, result.revision, result.generation, result.mode)
        });
        let result_identity = PreparationResultIdentity {
            id: result.id.clone(),
            revision: result.revision,
            generation: result.generation,
            mode: result.mode,
        };
        let target_id = if direct_match {
            result.id.clone()
        } else if let Some(adopted_id) = self.result_adoptions.remove(&result_identity) {
            adopted_id
        } else {
            return None;
        };
        let entry = self.entries.get_mut(&target_id).filter(|entry| {
            entry_accepts_result(entry, result.revision, result.generation, result.mode)
        })?;
        let replaced_fallback =
            match std::mem::replace(&mut entry.state, PreparedEntryState::Ready(result.content)) {
                PreparedEntryState::Pending { fallback, .. } => fallback,
                PreparedEntryState::Ready(_) => {
                    unreachable!("result correlation requires a pending preparation")
                }
            };
        self.result_adoptions
            .retain(|_, adopted_id| adopted_id != &target_id);
        self.publish_deferred_if_unblocked();
        Some(ContentPreparationAcceptance {
            target_id,
            replaced_fallback,
        })
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

    fn publish_candidates(&mut self, candidates: Vec<PreparationCandidate>, selected_id: &str) {
        let mut changed = false;
        for candidate in candidates {
            self.clock = self.clock.wrapping_add(1);
            if let Some(entry) = self.entries.get_mut(&candidate.id).filter(|entry| {
                entry.revision == candidate.revision && entry.mode == candidate.mode
            }) {
                entry.last_used = self.clock;
                continue;
            }
            self.evict_for(&candidate.id);
            let fallback = (candidate.mode == PreparationMode::Markdown)
                .then(|| self.entries.get(&candidate.id))
                .flatten()
                .and_then(|entry| match &entry.state {
                    PreparedEntryState::Ready(content)
                        if entry.mode == PreparationMode::StreamingMedia
                            && content.revision() == candidate.media_revision =>
                    {
                        Some(content.clone())
                    }
                    PreparedEntryState::Pending {
                        fallback: Some(content),
                        ..
                    } if content.revision() == candidate.media_revision => Some(content.clone()),
                    _ => None,
                });
            self.drop_result_adoptions_for(&candidate.id);
            self.entries.insert(
                candidate.id.clone(),
                PreparedEntry {
                    revision: candidate.revision,
                    mode: candidate.mode,
                    last_used: self.clock,
                    state: PreparedEntryState::Pending {
                        generation: 0,
                        fallback,
                        source: PreparationSource {
                            text: candidate.text,
                            media: candidate.media,
                        },
                    },
                },
            );
            changed = true;
        }
        if changed || self.selected_request_id.as_deref() != Some(selected_id) {
            self.publish_pending(selected_id);
        }
    }

    fn publish_pending(&mut self, selected_id: &str) {
        if !self.result_adoptions.is_empty() {
            self.deferred_selected_request_id = Some(selected_id.to_string());
            return;
        }
        self.deferred_selected_request_id = None;
        self.generation = self.generation.wrapping_add(1).max(1);
        let generation = self.generation;
        let mut requests = self
            .entries
            .iter_mut()
            .filter_map(|(id, entry)| {
                let PreparedEntryState::Pending {
                    generation: pending_generation,
                    source,
                    ..
                } = &mut entry.state
                else {
                    return None;
                };
                *pending_generation = generation;
                Some((
                    id == selected_id,
                    entry.last_used,
                    ContentPreparationRequest {
                        id: id.clone(),
                        revision: entry.revision,
                        generation,
                        text: source.text.clone(),
                        media: source.media.clone(),
                        mode: entry.mode,
                    },
                ))
            })
            .collect::<Vec<_>>();
        requests.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| right.1.cmp(&left.1))
                .then_with(|| left.2.id.cmp(&right.2.id))
        });
        let requests = requests
            .into_iter()
            .map(|(_, _, request)| request)
            .collect::<Vec<_>>();
        self.selected_request_id = Some(selected_id.to_string());
        if requests.is_empty() {
            return;
        }
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
            let entries = &self.entries;
            self.result_adoptions
                .retain(|_, adopted_id| entries.contains_key(adopted_id));
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
            self.drop_result_adoptions_for(&oldest);
            self.entries.remove(&oldest);
        }
    }

    fn drop_result_adoptions_for(&mut self, id: &str) {
        self.result_adoptions
            .retain(|identity, adopted_id| identity.id != id && adopted_id != id);
    }

    fn publish_deferred_if_unblocked(&mut self) {
        if self.result_adoptions.is_empty() {
            if let Some(selected_id) = self.deferred_selected_request_id.take() {
                self.publish_pending(&selected_id);
            }
        }
    }
}

fn entry_matches_adoption(entry: &PreparedEntry, adoption: &MomentIdentityAdoption) -> bool {
    match entry.mode {
        PreparationMode::Markdown => entry.revision == adoption.revision,
        PreparationMode::StreamingMedia => entry.revision == adoption.media_revision,
        PreparationMode::Literal => false,
    }
}

fn entry_accepts_result(
    entry: &PreparedEntry,
    revision: ContentRevision,
    generation: u64,
    mode: PreparationMode,
) -> bool {
    entry.revision == revision
        && entry.mode == mode
        && matches!(
            &entry.state,
            PreparedEntryState::Pending {
                generation: pending,
                ..
            } if *pending == generation
        )
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
        media_revision: content_revision("", media),
        text: if mode == PreparationMode::StreamingMedia {
            Arc::from("")
        } else {
            Arc::from(text)
        },
        media: Arc::new(media.to_vec()),
        mode,
    }
}

pub(super) async fn run_preparation_worker(
    mut requests: watch::Receiver<Option<ContentPreparationBatch>>,
    results: Sender<ContentPreparationResult>,
) {
    while requests.changed().await.is_ok() {
        'latest: loop {
            let Some(batch) = requests.borrow_and_update().clone() else {
                break;
            };
            for request in batch.requests {
                let content = match request.mode {
                    PreparationMode::Markdown => prepare_completed_assistant_with_revision(
                        request.revision,
                        request.text.as_ref(),
                        request.media.as_slice(),
                    ),
                    PreparationMode::Literal | PreparationMode::StreamingMedia => {
                        prepare_literal_content_with_revision(
                            request.revision,
                            request.text.as_ref(),
                            request.media.as_slice(),
                        )
                    }
                };
                let result = ContentPreparationResult {
                    id: request.id,
                    revision: request.revision,
                    generation: request.generation,
                    mode: request.mode,
                    content,
                };
                let sent = tokio::select! {
                    biased;
                    changed = requests.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        continue 'latest;
                    }
                    sent = results.send(result) => sent,
                };
                if sent.is_err() {
                    return;
                }
                match requests.has_changed() {
                    Ok(true) => continue 'latest,
                    Ok(false) => {}
                    Err(_) => return,
                }
            }
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn history_candidate(id: &str, text: &str) -> HistoryPreparationCandidate {
        let text: Arc<str> = Arc::from(text);
        let media = Arc::new(Vec::new());
        HistoryPreparationCandidate {
            id: Arc::from(id),
            revision: content_revision(text.as_ref(), media.as_slice()),
            media_revision: content_revision("", media.as_slice()),
            render_text: text.clone(),
            text,
            media,
        }
    }

    fn result_for(request: ContentPreparationRequest) -> ContentPreparationResult {
        let content = match request.mode {
            PreparationMode::Markdown => prepare_completed_assistant_with_revision(
                request.revision,
                request.text.as_ref(),
                request.media.as_slice(),
            ),
            PreparationMode::Literal | PreparationMode::StreamingMedia => {
                prepare_literal_content_with_revision(
                    request.revision,
                    request.text.as_ref(),
                    request.media.as_slice(),
                )
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

    fn adoption(
        transient_id: &str,
        durable_id: &str,
        text: &str,
        media: &[MediaAttachment],
    ) -> MomentIdentityAdoption {
        MomentIdentityAdoption {
            transient_id: transient_id.to_string(),
            durable_id: durable_id.to_string(),
            run_id: "run-adopt".to_string(),
            revision: content_revision(text, media),
            media_revision: content_revision("", media),
        }
    }

    #[test]
    fn pending_transient_preparation_finishes_under_the_durable_id_without_requeue() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let transient_id = "assistant:transient:1";
        let durable_id = "message:91";
        let text = "One **prepared** answer";
        assert!(cache
            .resolve_or_request(
                transient_id,
                MomentRole::Intelligence,
                MomentState::Complete,
                text,
                &[],
            )
            .is_none());
        let request = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("transient preparation request");

        assert_eq!(
            cache.adopt_identities(&[adoption(transient_id, durable_id, text, &[])]),
            1
        );
        let durable = history_candidate(durable_id, text);
        cache.preload_history(std::slice::from_ref(&durable), Some(durable_id));
        assert!(!requests
            .has_changed()
            .expect("preparation request channel remains open"));

        let result = result_for(request);
        let prepared_document = result.content.document().clone();
        assert!(cache.accept(result).is_some());
        let resolved = cache
            .resolve_history(&durable)
            .expect("old-id work should activate for the durable identity");
        assert!(Arc::ptr_eq(resolved.document(), &prepared_document));
        assert!(!requests
            .has_changed()
            .expect("preparation request channel remains open"));
    }

    #[test]
    fn adopted_acceptance_reports_the_durable_target_and_exact_replaced_fallback() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let transient_id = "assistant:transient:fallback";
        let durable_id = "message:fallback";
        let media = image_media("answer.png");
        assert!(cache
            .resolve_or_request(
                transient_id,
                MomentRole::Intelligence,
                MomentState::Streaming,
                "partial",
                &media,
            )
            .is_none());
        let streaming_request = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("streaming media request");
        let streaming_acceptance = cache
            .accept(result_for(streaming_request))
            .expect("streaming media result");
        assert_eq!(streaming_acceptance.target_id, transient_id);
        assert!(streaming_acceptance.replaced_fallback.is_none());

        let fallback = cache
            .resolve_or_request(
                transient_id,
                MomentRole::Intelligence,
                MomentState::Complete,
                "**finished**",
                &media,
            )
            .expect("streaming media remains visible during Markdown preparation");
        let markdown_request = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("Markdown request");
        assert_eq!(markdown_request.id, transient_id);
        assert_eq!(
            cache.adopt_identities(&[adoption(transient_id, durable_id, "**finished**", &media,)]),
            1
        );

        let acceptance = cache
            .accept(result_for(markdown_request))
            .expect("adopted Markdown result");

        assert_eq!(acceptance.target_id, durable_id);
        let replaced_fallback = acceptance
            .replaced_fallback
            .expect("the displayed streaming fallback is returned");
        assert_eq!(replaced_fallback.revision(), fallback.revision());
        assert!(Arc::ptr_eq(
            replaced_fallback.document(),
            fallback.document()
        ));
    }

    #[test]
    fn new_history_work_waits_for_adopted_work_instead_of_requeueing_it() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let transient_id = "assistant:transient:pending";
        let durable_id = "message:pending";
        let text = "Already parsing";
        assert!(cache
            .resolve_or_request(
                transient_id,
                MomentRole::Intelligence,
                MomentState::Complete,
                text,
                &[],
            )
            .is_none());
        let adopted_request = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("transient preparation request");
        assert_eq!(
            cache.adopt_identities(&[adoption(transient_id, durable_id, text, &[])]),
            1
        );

        let durable = history_candidate(durable_id, text);
        let later = history_candidate("message:later", "New history work");
        cache.preload_history(&[durable, later], Some(durable_id));
        assert!(!requests
            .has_changed()
            .expect("adopted request remains the active batch"));

        assert!(cache.accept(result_for(adopted_request)).is_some());
        assert!(requests
            .has_changed()
            .expect("deferred work publishes after adoption completes"));
        let next = requests
            .borrow_and_update()
            .clone()
            .expect("deferred history batch");
        assert_eq!(next.requests.len(), 1);
        assert_eq!(next.requests[0].id, "message:later");
    }

    #[test]
    fn adoption_rejects_a_mismatched_revision_without_moving_the_entry() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let transient_id = "assistant:transient:2";
        assert!(cache
            .resolve_or_request(
                transient_id,
                MomentRole::Intelligence,
                MomentState::Complete,
                "old answer",
                &[],
            )
            .is_none());
        let request = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("transient preparation request");

        assert_eq!(
            cache.adopt_identities(&[adoption(
                transient_id,
                "message:92",
                "different answer",
                &[],
            )]),
            0
        );
        assert!(cache.accept(result_for(request)).is_some());
        assert!(cache.is_ready(transient_id));
        assert!(!cache.is_ready("message:92"));
    }

    #[test]
    fn adopted_old_result_cannot_activate_after_the_durable_revision_changes() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let transient_id = "assistant:transient:3";
        let durable_id = "message:93";
        assert!(cache
            .resolve_or_request(
                transient_id,
                MomentRole::Intelligence,
                MomentState::Complete,
                "old answer",
                &[],
            )
            .is_none());
        let old = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("old request");
        assert_eq!(
            cache.adopt_identities(&[adoption(transient_id, durable_id, "old answer", &[],)]),
            1
        );

        assert!(cache
            .resolve_or_request(
                durable_id,
                MomentRole::Intelligence,
                MomentState::Complete,
                "new answer",
                &[],
            )
            .is_none());

        assert!(cache.accept(result_for(old)).is_none());
        assert!(cache.is_pending(durable_id));
        assert!(!cache.is_ready(durable_id));
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

        assert!(cache.accept(result_for(old)).is_none());
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
    fn history_preload_queues_every_bounded_candidate_once_with_shared_content() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let candidates = (0..crate::history::MAX_FETCHED_HISTORY_MESSAGES)
            .map(|index| {
                history_candidate(&format!("assistant-{index}"), &format!("reply {index}"))
            })
            .collect::<Vec<_>>();
        let selected = candidates[73].id.clone();

        cache.preload_history(&candidates, Some(&selected));

        let batch = requests
            .borrow_and_update()
            .clone()
            .expect("history preparation batch");
        assert_eq!(
            batch.requests.len(),
            crate::history::MAX_FETCHED_HISTORY_MESSAGES
        );
        assert_eq!(batch.requests[0].id, selected.as_ref());
        let source = candidates
            .iter()
            .find(|candidate| candidate.id.as_ref() == batch.requests[0].id)
            .expect("selected source");
        assert!(Arc::ptr_eq(&batch.requests[0].text, &source.text));
        assert!(Arc::ptr_eq(&batch.requests[0].media, &source.media));

        let generation = batch.requests[0].generation;
        cache.preload_history(&candidates, Some(&selected));
        let unchanged = requests
            .borrow_and_update()
            .clone()
            .expect("unchanged history preparation batch");
        assert_eq!(unchanged.requests[0].generation, generation);
    }

    #[test]
    fn history_resolve_can_requeue_an_evicted_candidate_without_rehashing() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let candidate = history_candidate("assistant", "prepared in the client");

        assert!(cache.resolve_history(&candidate).is_none());

        let batch = requests
            .borrow_and_update()
            .clone()
            .expect("history preparation batch");
        let request = batch.requests.first().expect("history preparation request");
        assert_eq!(request.revision, candidate.revision);
        assert!(Arc::ptr_eq(&request.text, &candidate.text));
        assert!(Arc::ptr_eq(&request.media, &candidate.media));
    }

    #[test]
    fn reprioritizing_republishes_all_pending_and_rejects_the_old_generation() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let candidates = vec![
            history_candidate("first", "one"),
            history_candidate("second", "two"),
        ];
        cache.preload_history(&candidates, Some("first"));
        let old = requests
            .borrow_and_update()
            .clone()
            .expect("first generation");

        assert!(cache.resolve_history(&candidates[1]).is_none());
        let latest = requests
            .borrow_and_update()
            .clone()
            .expect("latest generation");
        assert_eq!(latest.requests.len(), 2);
        assert_eq!(latest.requests[0].id, "second");
        assert!(latest.requests[0].generation > old.requests[0].generation);
        assert!(latest
            .requests
            .iter()
            .all(|request| request.generation == latest.requests[0].generation));

        let old_first = old
            .requests
            .into_iter()
            .find(|request| request.id == "first")
            .expect("old first request");
        assert!(cache.accept(result_for(old_first)).is_none());
        let latest_first = latest
            .requests
            .into_iter()
            .find(|request| request.id == "first")
            .expect("latest first request");
        assert!(cache.accept(result_for(latest_first)).is_some());
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
        assert_eq!(batch.requests[0].text.as_ref(), "revision 99");
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
        assert_eq!(streaming.text.as_ref(), "");
        assert!(cache.accept(result_for(streaming)).is_some());
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
        let retained_fallback = cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "**finished**",
                &media,
            )
            .expect("resolving the same completion must retain live media");
        assert_eq!(retained_fallback.media().len(), 1);
        let batch = requests
            .borrow_and_update()
            .clone()
            .expect("completion batch");
        assert_eq!(batch.requests[0].mode, PreparationMode::Markdown);
        assert!(cache
            .accept(result_for(batch.requests[0].clone()))
            .is_some());
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
        assert!(cache.accept(result_for(streaming)).is_some());

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

    #[test]
    fn worker_keeps_at_most_one_old_result_and_moves_to_the_latest_generation() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            let (mut cache, requests, results, mut result_receiver) = PreparedContentCache::new();
            let worker = tokio::spawn(run_preparation_worker(requests, results));
            assert!(cache
                .resolve_or_request(
                    "assistant",
                    MomentRole::Intelligence,
                    MomentState::Complete,
                    "old",
                    &[],
                )
                .is_none());
            tokio::task::yield_now().await;

            for text in ["newer", "latest"] {
                assert!(cache
                    .resolve_or_request(
                        "assistant",
                        MomentRole::Intelligence,
                        MomentState::Complete,
                        text,
                        &[],
                    )
                    .is_none());
            }
            let expected = content_revision("latest", &[]);
            let mut observed_latest = false;
            for _ in 0..2 {
                let result =
                    tokio::time::timeout(std::time::Duration::from_secs(1), result_receiver.recv())
                        .await
                        .expect("worker result timeout")
                        .expect("worker result");
                if result.revision == expected {
                    observed_latest = true;
                    assert!(cache.accept(result).is_some());
                    break;
                }
                assert!(cache.accept(result).is_none());
            }
            assert!(observed_latest);
            assert!(result_receiver.try_recv().is_err());
            worker.abort();
        });
    }
}
