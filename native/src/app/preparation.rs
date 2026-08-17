use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::Arc;
use std::time::Duration;

use gpui::BackgroundExecutor;
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
const STREAMING_PREPARATION_INTERVAL: Duration = Duration::from_millis(40);

#[derive(Clone)]
pub(super) struct ContentPreparationRequest {
    id: String,
    revision: PreparationRevision,
    generation: u64,
    text: Arc<str>,
    media: Arc<Vec<MediaAttachment>>,
    mode: PreparationMode,
    streaming: bool,
}

#[derive(Clone)]
pub(super) struct ContentPreparationBatch {
    requests: Vec<ContentPreparationRequest>,
}

pub(super) struct ContentPreparationResult {
    pub id: String,
    revision: PreparationRevision,
    generation: u64,
    mode: PreparationMode,
    text: Arc<str>,
    media: Arc<Vec<MediaAttachment>>,
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
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum PreparationRevision {
    Content(ContentRevision),
    Streaming(u64),
}

enum PreparedEntryState {
    Pending {
        generation: u64,
        fallback: Option<PreparedContent>,
    },
    Ready(PreparedContent),
}

#[derive(Clone)]
struct PreparationSource {
    text: Arc<str>,
    media: Arc<Vec<MediaAttachment>>,
    streaming: bool,
}

struct PreparedEntry {
    revision: PreparationRevision,
    mode: PreparationMode,
    last_used: u64,
    source: PreparationSource,
    state: PreparedEntryState,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PreparationResultIdentity {
    id: String,
    revision: PreparationRevision,
    generation: u64,
    mode: PreparationMode,
}

struct PreparationCandidate {
    id: String,
    revision: PreparationRevision,
    text: Arc<str>,
    media: Arc<Vec<MediaAttachment>>,
    mode: PreparationMode,
    streaming: bool,
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

    pub fn clear(&mut self) {
        self.entries.clear();
        self.result_adoptions.clear();
        self.selected_request_id = None;
        self.deferred_selected_request_id = None;
        self.generation = self.generation.wrapping_add(1).max(1);
        let _ = self.requests.send(None);
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
        if let Some(entry) = self.entries.get_mut(id).filter(|entry| {
            entry.revision == PreparationRevision::Content(revision)
                && entry.mode == mode
                && entry.source.text.as_ref() == text
                && entry.source.media.as_slice() == media
        }) {
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

        let candidate = preparation_candidate(id, text, media, mode, revision, false);
        self.publish_candidates(vec![candidate], id);
        self.entries.get(id).and_then(|entry| match &entry.state {
            PreparedEntryState::Pending { fallback, .. } => fallback.clone(),
            PreparedEntryState::Ready(content) => Some(content.clone()),
        })
    }

    pub fn resolve_streaming(
        &mut self,
        id: &str,
        source_revision: u64,
        text: Arc<str>,
        media: Arc<Vec<MediaAttachment>>,
    ) -> Option<PreparedContent> {
        let revision = PreparationRevision::Streaming(source_revision);
        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self.entries.get_mut(id).filter(|entry| {
            entry.revision == revision
                && entry.mode == PreparationMode::Markdown
                && entry.source.text.as_ref() == text.as_ref()
                && entry.source.media.as_slice() == media.as_slice()
        }) {
            entry.last_used = self.clock;
            return match &entry.state {
                PreparedEntryState::Ready(content) => Some(content.clone()),
                PreparedEntryState::Pending { fallback, .. } => fallback.clone(),
            };
        }

        self.publish_candidates(
            vec![PreparationCandidate {
                id: id.to_string(),
                revision,
                text,
                media,
                mode: PreparationMode::Markdown,
                streaming: true,
            }],
            id,
        );
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
            entry.revision == PreparationRevision::Content(candidate.revision)
                && entry.mode == PreparationMode::Markdown
                && entry.source.text.as_ref() == candidate.text.as_ref()
                && entry.source.media.as_slice() == candidate.media.as_slice()
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
        if let Some(entry) = self.entries.get_mut(candidate.id.as_ref()).filter(|entry| {
            entry.mode == PreparationMode::Markdown
                && entry.source.text.as_ref() == candidate.text.as_ref()
                && entry.source.media.as_slice() == candidate.media.as_slice()
        }) {
            entry.last_used = self.clock;
            match &entry.state {
                PreparedEntryState::Pending { fallback, .. } => {
                    let fallback = fallback.clone();
                    if self.selected_request_id.as_deref() != Some(candidate.id.as_ref()) {
                        self.publish_pending(&candidate.id);
                    }
                    return fallback;
                }
                PreparedEntryState::Ready(content) if content.revision() == candidate.revision => {
                    entry.revision = PreparationRevision::Content(candidate.revision);
                    entry.source.streaming = false;
                    return Some(content.clone());
                }
                PreparedEntryState::Ready(_) => {}
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
                revision: PreparationRevision::Content(candidate.revision),
                text: candidate.text.clone(),
                media: candidate.media.clone(),
                mode: PreparationMode::Markdown,
                streaming: false,
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
                revision: PreparationRevision::Content(candidate.revision),
                text: candidate.text.clone(),
                media: candidate.media.clone(),
                mode: PreparationMode::Markdown,
                streaming: false,
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
        if source.mode == PreparationMode::Markdown
            && matches!(&source.state, PreparedEntryState::Ready(content) if content.revision() == adoption.revision)
        {
            source.revision = PreparationRevision::Content(adoption.revision);
            source.source.streaming = false;
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
        if matches!(result.revision, PreparationRevision::Content(revision) if result.content.revision() != revision)
        {
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
                && Arc::ptr_eq(&entry.source.text, &result.text)
                && Arc::ptr_eq(&entry.source.media, &result.media)
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
                entry.revision == candidate.revision
                    && entry.mode == candidate.mode
                    && entry.source.text.as_ref() == candidate.text.as_ref()
                    && entry.source.media.as_slice() == candidate.media.as_slice()
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
                        if entry.mode == PreparationMode::Markdown =>
                    {
                        Some(content.clone())
                    }
                    PreparedEntryState::Pending {
                        fallback: Some(content),
                        ..
                    } if entry.mode == PreparationMode::Markdown => Some(content.clone()),
                    _ => None,
                });
            self.drop_result_adoptions_for(&candidate.id);
            self.entries.insert(
                candidate.id.clone(),
                PreparedEntry {
                    revision: candidate.revision,
                    mode: candidate.mode,
                    last_used: self.clock,
                    source: PreparationSource {
                        text: candidate.text,
                        media: candidate.media,
                        streaming: candidate.streaming,
                    },
                    state: PreparedEntryState::Pending {
                        generation: 0,
                        fallback,
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
                        text: entry.source.text.clone(),
                        media: entry.source.media.clone(),
                        mode: entry.mode,
                        streaming: entry.source.streaming,
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
        PreparationMode::Markdown => {
            entry.revision == PreparationRevision::Content(adoption.revision)
                || matches!(entry.revision, PreparationRevision::Streaming(_))
        }
        PreparationMode::Literal => false,
    }
}

fn entry_accepts_result(
    entry: &PreparedEntry,
    revision: PreparationRevision,
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
        _ => return None,
    };
    Some((mode, content_revision(text, media)))
}

fn preparation_candidate(
    id: &str,
    text: &str,
    media: &[MediaAttachment],
    mode: PreparationMode,
    revision: ContentRevision,
    streaming: bool,
) -> PreparationCandidate {
    PreparationCandidate {
        id: id.to_string(),
        revision: PreparationRevision::Content(revision),
        text: Arc::from(text),
        media: Arc::new(media.to_vec()),
        mode,
        streaming,
    }
}

pub(super) async fn run_preparation_worker(
    mut requests: watch::Receiver<Option<ContentPreparationBatch>>,
    results: Sender<ContentPreparationResult>,
    executor: BackgroundExecutor,
) {
    let mut last_streaming_preparation = None;
    while requests.changed().await.is_ok() {
        'latest: loop {
            let Some(batch) = requests.borrow_and_update().clone() else {
                break;
            };
            if batch
                .requests
                .first()
                .is_some_and(|request| request.streaming)
            {
                if let Some(last_preparation) = last_streaming_preparation {
                    let elapsed = executor.now().saturating_duration_since(last_preparation);
                    if elapsed < STREAMING_PREPARATION_INTERVAL {
                        tokio::select! {
                            biased;
                            changed = requests.changed() => {
                                if changed.is_err() {
                                    return;
                                }
                                continue 'latest;
                            }
                            () = executor.timer(STREAMING_PREPARATION_INTERVAL - elapsed) => {}
                        }
                    }
                }
            }
            for request in batch.requests {
                let content_revision = match request.revision {
                    PreparationRevision::Content(revision) => revision,
                    PreparationRevision::Streaming(_) => {
                        content_revision(request.text.as_ref(), request.media.as_slice())
                    }
                };
                if request.streaming {
                    last_streaming_preparation = Some(executor.now());
                }
                let content = match request.mode {
                    PreparationMode::Markdown => prepare_completed_assistant_with_revision(
                        content_revision,
                        request.text.as_ref(),
                        request.media.as_slice(),
                    ),
                    PreparationMode::Literal => prepare_literal_content_with_revision(
                        content_revision,
                        request.text.as_ref(),
                        request.media.as_slice(),
                    ),
                };
                let result = ContentPreparationResult {
                    id: request.id,
                    revision: request.revision,
                    generation: request.generation,
                    mode: request.mode,
                    text: request.text,
                    media: request.media,
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
        let content_revision = match request.revision {
            PreparationRevision::Content(revision) => revision,
            PreparationRevision::Streaming(_) => {
                content_revision(request.text.as_ref(), request.media.as_slice())
            }
        };
        let content = match request.mode {
            PreparationMode::Markdown => prepare_completed_assistant_with_revision(
                content_revision,
                request.text.as_ref(),
                request.media.as_slice(),
            ),
            PreparationMode::Literal => prepare_literal_content_with_revision(
                content_revision,
                request.text.as_ref(),
                request.media.as_slice(),
            ),
        };
        ContentPreparationResult {
            id: request.id,
            revision: request.revision,
            generation: request.generation,
            mode: request.mode,
            text: request.text,
            media: request.media,
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
            .resolve_streaming(
                transient_id,
                1,
                Arc::from("partial"),
                Arc::new(media.clone()),
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
        assert_eq!(
            request.revision,
            PreparationRevision::Content(candidate.revision)
        );
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
    fn streaming_assistant_snapshots_are_prepared_as_markdown() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let text: Arc<str> = Arc::from("**partial**");
        let media = Arc::new(image_media("result.png"));
        assert!(cache
            .resolve_streaming("assistant", 41, text.clone(), media.clone(),)
            .is_none());
        let streaming = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("streaming Markdown batch");
        assert_eq!(streaming.mode, PreparationMode::Markdown);
        assert!(streaming.streaming);
        assert_eq!(streaming.revision, PreparationRevision::Streaming(41));
        assert_eq!(streaming.text.as_ref(), "**partial**");
        assert!(Arc::ptr_eq(&streaming.text, &text));
        assert!(Arc::ptr_eq(&streaming.media, &media));
        let acceptance = cache
            .accept(result_for(streaming))
            .expect("streaming Markdown result");
        assert!(acceptance.replaced_fallback.is_none());
        let prepared = cache
            .resolve_streaming("assistant", 41, text, media)
            .expect("prepared streaming Markdown");
        assert!(prepared.is_rich());
        assert_eq!(prepared.media().len(), 1);
    }

    #[test]
    fn non_prefix_stream_correction_replaces_the_queued_snapshot_and_keeps_last_prepared() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        assert!(cache
            .resolve_streaming(
                "assistant",
                1,
                Arc::from("before **old tail**"),
                Arc::new(Vec::new()),
            )
            .is_none());
        let old = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("old streaming request");
        assert!(cache.accept(result_for(old)).is_some());

        let fallback = cache
            .resolve_streaming(
                "assistant",
                2,
                Arc::from("# corrected"),
                Arc::new(Vec::new()),
            )
            .expect("last exact prepared snapshot remains visible");
        assert!(fallback.is_rich());
        let corrected = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("corrected streaming request");
        assert_eq!(corrected.text.as_ref(), "# corrected");
        assert_eq!(corrected.revision, PreparationRevision::Streaming(2));
        let acceptance = cache
            .accept(result_for(corrected))
            .expect("corrected result");
        assert_eq!(
            acceptance
                .replaced_fallback
                .expect("exact old fallback")
                .revision(),
            fallback.revision()
        );
    }

    #[test]
    fn identical_completion_reuses_the_streaming_markdown_document() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let text = "One **finished** answer";
        let source: Arc<str> = Arc::from(text);
        let media = Arc::new(Vec::new());
        assert!(cache
            .resolve_streaming("assistant", 72, source.clone(), media.clone(),)
            .is_none());
        let request = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("streaming request");
        assert!(cache.accept(result_for(request)).is_some());
        let streaming = cache
            .resolve_streaming("assistant", 72, source, media)
            .expect("streaming result");

        let completed = cache
            .resolve_history(&history_candidate("assistant", text))
            .expect("completion reuses the exact revision");

        assert!(Arc::ptr_eq(streaming.document(), completed.document()));
        assert!(!requests
            .has_changed()
            .expect("preparation request channel remains open"));
    }

    #[test]
    fn completion_reuses_an_exact_pending_final_stream_request() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let candidate = history_candidate("assistant", "Final **answer**");
        assert!(cache
            .resolve_streaming(
                "assistant",
                91,
                candidate.text.clone(),
                candidate.media.clone(),
            )
            .is_none());
        let final_stream = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("final streaming request");

        assert!(cache.resolve_history(&candidate).is_none());
        assert!(!requests
            .has_changed()
            .expect("completion does not replace exact in-flight work"));
        assert!(cache.accept(result_for(final_stream)).is_some());

        let completed = cache
            .resolve_history(&candidate)
            .expect("the in-flight stream result becomes completion");
        assert_eq!(completed.revision(), candidate.revision);
        assert!(!requests
            .has_changed()
            .expect("completion remains fully prepared"));
    }

    #[test]
    fn completion_revision_token_cannot_reuse_different_raw_source() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let source: Arc<str> = Arc::from("first raw");
        let media = Arc::new(Vec::new());
        assert!(cache
            .resolve_streaming("assistant", 1, source, media)
            .is_none());
        let stream = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("stream request");
        let forced_revision = result_for(stream).content.revision();
        let stream = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("stream request retained");
        assert!(cache.accept(result_for(stream)).is_some());

        let text: Arc<str> = Arc::from("different raw");
        let candidate = HistoryPreparationCandidate {
            id: Arc::from("assistant"),
            revision: forced_revision,
            media_revision: content_revision("", &[]),
            render_text: text.clone(),
            text,
            media: Arc::new(Vec::new()),
        };
        assert!(cache.resolve_history(&candidate).is_some());
        let replacement = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("different raw is prepared independently");
        assert_eq!(replacement.text.as_ref(), "different raw");
    }

    #[test]
    fn content_revision_token_cannot_reuse_a_ready_different_raw_source() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "first raw",
                &[],
            )
            .is_none());
        let first = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("first content request");
        let forced_revision = match first.revision {
            PreparationRevision::Content(revision) => revision,
            PreparationRevision::Streaming(_) => unreachable!("completed content revision"),
        };
        let first_result = result_for(first);
        let first_document = first_result.content.document().clone();
        assert!(cache.accept(first_result).is_some());

        let text: Arc<str> = Arc::from("different raw");
        let candidate = HistoryPreparationCandidate {
            id: Arc::from("assistant"),
            revision: forced_revision,
            media_revision: content_revision("", &[]),
            render_text: text.clone(),
            text,
            media: Arc::new(Vec::new()),
        };
        let fallback = cache
            .resolve_history(&candidate)
            .expect("last exact document remains visible");
        assert!(Arc::ptr_eq(fallback.document(), &first_document));
        let replacement = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("different raw is prepared independently");
        assert_eq!(replacement.text.as_ref(), "different raw");
    }

    #[test]
    fn content_revision_token_cannot_reuse_a_pending_different_raw_source() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        assert!(cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "first raw",
                &[],
            )
            .is_none());
        let first = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("first content request");
        let forced_revision = match first.revision {
            PreparationRevision::Content(revision) => revision,
            PreparationRevision::Streaming(_) => unreachable!("completed content revision"),
        };

        let text: Arc<str> = Arc::from("different raw");
        let candidate = HistoryPreparationCandidate {
            id: Arc::from("assistant"),
            revision: forced_revision,
            media_revision: content_revision("", &[]),
            render_text: text.clone(),
            text,
            media: Arc::new(Vec::new()),
        };
        assert!(cache.resolve_history(&candidate).is_none());
        let replacement = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("different raw supersedes pending work");
        assert_eq!(replacement.text.as_ref(), "different raw");
        assert!(cache.accept(result_for(first)).is_none());
        assert!(cache.accept(result_for(replacement)).is_some());
    }

    #[test]
    fn newer_streaming_markdown_keeps_attachment_media_in_its_fallback() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let media = image_media("result.png");
        assert!(cache
            .resolve_streaming("assistant", 1, Arc::from("first"), Arc::new(media.clone()),)
            .is_none());
        let first = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("first request");
        assert!(cache.accept(result_for(first)).is_some());

        let fallback = cache
            .resolve_streaming("assistant", 2, Arc::from("second"), Arc::new(media.clone()))
            .expect("attachment remains visible while the next snapshot prepares");
        assert_eq!(fallback.media().len(), 1);
        let batch = requests
            .borrow_and_update()
            .clone()
            .expect("new streaming batch");
        assert_eq!(batch.requests[0].mode, PreparationMode::Markdown);
        assert!(cache
            .accept(result_for(batch.requests[0].clone()))
            .is_some());
    }

    #[test]
    fn changed_completion_media_keeps_the_old_document_only_as_a_pending_fallback() {
        let (mut cache, mut requests, _results, _result_receiver) = PreparedContentCache::new();
        let streaming_media = image_media("partial.png");
        assert!(cache
            .resolve_streaming(
                "assistant",
                1,
                Arc::from("partial"),
                Arc::new(streaming_media.clone()),
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
        let fallback = cache
            .resolve_or_request(
                "assistant",
                MomentRole::Intelligence,
                MomentState::Complete,
                "finished",
                &completed_media,
            )
            .expect("old prepared document remains visible while completion prepares");
        assert_eq!(
            fallback.media()[0].cache_key.as_ref(),
            "process:partial.png"
        );
        let pending = requests
            .borrow_and_update()
            .as_ref()
            .and_then(|batch| batch.requests.first())
            .cloned()
            .expect("changed completion request");
        assert_eq!(pending.media.as_slice(), completed_media.as_slice());
    }

    #[gpui::test]
    async fn worker_coalesces_streaming_work_to_one_old_result_and_the_latest_snapshot(
        cx: &mut gpui::TestAppContext,
    ) {
        let (mut cache, requests, results, mut result_receiver) = PreparedContentCache::new();
        let worker = cx.background_executor.spawn(run_preparation_worker(
            requests,
            results,
            cx.background_executor.clone(),
        ));
        assert!(cache
            .resolve_streaming("assistant", 1, Arc::from("old"), Arc::new(Vec::new()),)
            .is_none());
        let first = result_receiver.recv().await.expect("first worker result");
        assert_eq!(first.revision, PreparationRevision::Streaming(1));
        assert!(cache.accept(first).is_some());

        for (revision, text) in [(2, "newer"), (3, "latest")] {
            assert!(cache
                .resolve_streaming("assistant", revision, Arc::from(text), Arc::new(Vec::new()),)
                .is_some());
        }
        let latest = result_receiver.recv().await.expect("latest worker result");
        assert_eq!(latest.revision, PreparationRevision::Streaming(3));
        assert!(cache.accept(latest).is_some());
        assert!(result_receiver.try_recv().is_err());
        drop(worker);
    }
}
