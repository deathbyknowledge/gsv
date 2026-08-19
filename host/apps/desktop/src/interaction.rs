#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanvasLayer {
    Moment,
    Draft,
    ApprovalPrompt,
    ApprovalDraft,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingSubmission {
    pub id: u64,
    pub moment_id: String,
    pub text: String,
    pub attachment_ids: Vec<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingApprovalSubmission {
    pub request_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubmissionFailure {
    RestoreDraft {
        moment_id: String,
        text: String,
        attachment_ids: Vec<u64>,
    },
    PreserveFailedMoment {
        moment_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApprovalSubmissionFailure {
    RestoreDecision { text: String },
    PreserveNewerDecision,
}

#[derive(Debug)]
pub struct CanvasInteraction {
    pub layer: CanvasLayer,
    conversation_draft: String,
    conversation_has_attachments: bool,
    approval_draft: String,
    resume_after_approval: CanvasLayer,
    pending_submission: Option<PendingSubmission>,
    pending_approval_submission: Option<PendingApprovalSubmission>,
    next_submission_id: u64,
    has_interacted: bool,
}

impl CanvasInteraction {
    pub fn new() -> Self {
        Self {
            layer: CanvasLayer::Moment,
            conversation_draft: String::new(),
            conversation_has_attachments: false,
            approval_draft: String::new(),
            resume_after_approval: CanvasLayer::Moment,
            pending_submission: None,
            pending_approval_submission: None,
            next_submission_id: 1,
            has_interacted: false,
        }
    }

    pub fn on_input(&mut self, value: String) {
        self.has_interacted = true;
        match self.layer {
            CanvasLayer::ApprovalPrompt | CanvasLayer::ApprovalDraft => {
                self.approval_draft = value;
                self.layer = if self.approval_draft.is_empty() {
                    CanvasLayer::ApprovalPrompt
                } else {
                    CanvasLayer::ApprovalDraft
                };
            }
            CanvasLayer::Moment | CanvasLayer::Draft => {
                self.conversation_draft = value;
                self.layer =
                    if self.conversation_draft.is_empty() && !self.conversation_has_attachments {
                        CanvasLayer::Moment
                    } else {
                        CanvasLayer::Draft
                    };
            }
        }
    }

    pub fn hide_draft(&mut self) -> bool {
        match self.layer {
            CanvasLayer::Draft => {
                self.layer = CanvasLayer::Moment;
                true
            }
            CanvasLayer::ApprovalDraft => {
                self.layer = CanvasLayer::ApprovalPrompt;
                true
            }
            CanvasLayer::Moment | CanvasLayer::ApprovalPrompt => false,
        }
    }

    pub fn show_conversation_draft(&mut self) {
        if (!self.conversation_draft.is_empty() || self.conversation_has_attachments)
            && !self.is_approval()
        {
            self.layer = CanvasLayer::Draft;
        }
    }

    pub fn set_conversation_has_attachments(&mut self, has_attachments: bool) {
        self.conversation_has_attachments = has_attachments;
        if has_attachments {
            self.has_interacted = true;
            if self.is_approval() {
                self.resume_after_approval = CanvasLayer::Draft;
            } else {
                self.layer = CanvasLayer::Draft;
            }
        } else if self.conversation_draft.is_empty() {
            if self.is_approval() {
                if self.resume_after_approval == CanvasLayer::Draft {
                    self.resume_after_approval = CanvasLayer::Moment;
                }
            } else if self.layer == CanvasLayer::Draft {
                self.layer = CanvasLayer::Moment;
            }
        }
    }

    #[cfg(test)]
    pub fn begin_submission(&mut self, text: String, moment_id: String) -> Option<u64> {
        self.begin_submission_with_attachments(text, moment_id, Vec::new())
    }

    pub fn begin_submission_with_attachments(
        &mut self,
        text: String,
        moment_id: String,
        attachment_ids: Vec<u64>,
    ) -> Option<u64> {
        if self.pending_submission.is_some() {
            return None;
        }

        let id = self.next_submission_id;
        self.next_submission_id = self.next_submission_id.saturating_add(1);
        self.pending_submission = Some(PendingSubmission {
            id,
            moment_id,
            text,
            attachment_ids,
        });
        self.conversation_draft.clear();
        self.conversation_has_attachments = false;
        self.layer = CanvasLayer::Moment;
        Some(id)
    }

    pub fn submission_accepted(&mut self, id: u64) -> Option<PendingSubmission> {
        if self
            .pending_submission
            .as_ref()
            .is_none_or(|submission| submission.id != id)
        {
            return None;
        }
        self.pending_submission.take()
    }

    pub fn submission_failed(&mut self, id: u64) -> Option<SubmissionFailure> {
        let submission = self.pending_submission.take()?;
        if submission.id != id {
            self.pending_submission = Some(submission);
            return None;
        }

        if self.conversation_draft.is_empty() && !self.conversation_has_attachments {
            self.conversation_draft = submission.text.clone();
            self.conversation_has_attachments = !submission.attachment_ids.is_empty();
            if self.is_approval() {
                self.resume_after_approval = CanvasLayer::Draft;
            } else {
                self.layer = CanvasLayer::Draft;
            }
            Some(SubmissionFailure::RestoreDraft {
                moment_id: submission.moment_id,
                text: submission.text,
                attachment_ids: submission.attachment_ids,
            })
        } else {
            Some(SubmissionFailure::PreserveFailedMoment {
                moment_id: submission.moment_id,
            })
        }
    }

    pub fn enter_approval(&mut self) {
        if !self.is_approval() {
            self.resume_after_approval = match self.layer {
                CanvasLayer::Draft => CanvasLayer::Draft,
                CanvasLayer::Moment => CanvasLayer::Moment,
                CanvasLayer::ApprovalPrompt | CanvasLayer::ApprovalDraft => unreachable!(),
            };
        }
        self.approval_draft.clear();
        self.pending_approval_submission = None;
        self.layer = CanvasLayer::ApprovalPrompt;
    }

    pub fn begin_approval_submission(&mut self, request_id: String, text: String) -> bool {
        if self.pending_approval_submission.is_some() {
            return false;
        }
        self.pending_approval_submission = Some(PendingApprovalSubmission { request_id, text });
        self.approval_draft.clear();
        self.layer = CanvasLayer::ApprovalPrompt;
        true
    }

    pub fn approval_submission_accepted(&mut self, request_id: &str) -> bool {
        if self
            .pending_approval_submission
            .as_ref()
            .is_none_or(|submission| submission.request_id != request_id)
        {
            return false;
        }
        self.pending_approval_submission = None;
        true
    }

    pub fn approval_submission_failed(
        &mut self,
        request_id: &str,
    ) -> Option<ApprovalSubmissionFailure> {
        let submission = self.pending_approval_submission.take()?;
        if submission.request_id != request_id {
            self.pending_approval_submission = Some(submission);
            return None;
        }
        if self.approval_draft.is_empty() {
            self.approval_draft = submission.text.clone();
            self.layer = CanvasLayer::ApprovalDraft;
            Some(ApprovalSubmissionFailure::RestoreDecision {
                text: submission.text,
            })
        } else {
            Some(ApprovalSubmissionFailure::PreserveNewerDecision)
        }
    }

    pub fn leave_approval(&mut self) {
        self.approval_draft.clear();
        self.pending_approval_submission = None;
        self.layer = if self.resume_after_approval == CanvasLayer::Draft
            && (!self.conversation_draft.is_empty() || self.conversation_has_attachments)
        {
            CanvasLayer::Draft
        } else {
            CanvasLayer::Moment
        };
        self.resume_after_approval = CanvasLayer::Moment;
    }

    pub fn conversation_draft(&self) -> &str {
        &self.conversation_draft
    }

    pub fn approval_draft(&self) -> &str {
        &self.approval_draft
    }

    pub fn visible_draft(&self) -> Option<&str> {
        match self.layer {
            CanvasLayer::Draft => Some(&self.conversation_draft),
            CanvasLayer::ApprovalDraft => Some(&self.approval_draft),
            CanvasLayer::Moment | CanvasLayer::ApprovalPrompt => None,
        }
    }

    pub fn held_draft(&self) -> bool {
        (!self.conversation_draft.is_empty() || self.conversation_has_attachments)
            && self.layer != CanvasLayer::Draft
    }

    pub fn is_approval(&self) -> bool {
        matches!(
            self.layer,
            CanvasLayer::ApprovalPrompt | CanvasLayer::ApprovalDraft
        )
    }

    pub fn is_submitting(&self) -> bool {
        self.pending_submission.is_some()
    }

    pub fn is_approval_submitting(&self) -> bool {
        self.pending_approval_submission.is_some()
    }

    pub fn has_interacted(&self) -> bool {
        self.has_interacted
    }
}

impl Default for CanvasInteraction {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_the_last_character_restores_the_moment() {
        let mut interaction = CanvasInteraction::new();
        interaction.on_input("hello".to_string());
        assert_eq!(interaction.layer, CanvasLayer::Draft);

        interaction.on_input(String::new());
        assert_eq!(interaction.layer, CanvasLayer::Moment);
        assert_eq!(interaction.visible_draft(), None);
    }

    #[test]
    fn escape_hides_without_discarding_a_draft() {
        let mut interaction = CanvasInteraction::new();
        interaction.on_input("unfinished".to_string());

        assert!(interaction.hide_draft());
        assert_eq!(interaction.layer, CanvasLayer::Moment);
        assert_eq!(interaction.conversation_draft(), "unfinished");

        interaction.show_conversation_draft();
        assert_eq!(interaction.visible_draft(), Some("unfinished"));
    }

    #[test]
    fn approval_never_consumes_an_unrelated_draft() {
        let mut interaction = CanvasInteraction::new();
        interaction.on_input("keep this thought".to_string());
        interaction.enter_approval();

        assert_eq!(interaction.layer, CanvasLayer::ApprovalPrompt);
        assert_eq!(interaction.conversation_draft(), "keep this thought");
        assert_eq!(interaction.approval_draft(), "");

        interaction.on_input("allow once".to_string());
        assert_eq!(interaction.layer, CanvasLayer::ApprovalDraft);
        assert_eq!(interaction.conversation_draft(), "keep this thought");

        interaction.leave_approval();
        assert_eq!(interaction.visible_draft(), Some("keep this thought"));
    }

    #[test]
    fn failed_delivery_restores_the_exact_submission() {
        let mut interaction = CanvasInteraction::new();
        interaction.on_input("do not lose me".to_string());
        let id = interaction
            .begin_submission("do not lose me".to_string(), "user:1".to_string())
            .expect("submission should start");

        assert_eq!(
            interaction.submission_failed(id),
            Some(SubmissionFailure::RestoreDraft {
                moment_id: "user:1".to_string(),
                text: "do not lose me".to_string(),
                attachment_ids: Vec::new(),
            })
        );
        assert_eq!(interaction.visible_draft(), Some("do not lose me"));
    }

    #[test]
    fn failed_delivery_does_not_overwrite_a_newer_draft() {
        let mut interaction = CanvasInteraction::new();
        interaction.on_input("first".to_string());
        let id = interaction
            .begin_submission("first".to_string(), "user:1".to_string())
            .expect("submission should start");
        interaction.on_input("second".to_string());

        assert_eq!(
            interaction.submission_failed(id),
            Some(SubmissionFailure::PreserveFailedMoment {
                moment_id: "user:1".to_string(),
            })
        );
        assert_eq!(interaction.visible_draft(), Some("second"));
    }

    #[test]
    fn failed_delivery_is_restored_behind_an_approval() {
        let mut interaction = CanvasInteraction::new();
        interaction.on_input("first".to_string());
        let id = interaction
            .begin_submission("first".to_string(), "user:1".to_string())
            .expect("submission should start");
        interaction.enter_approval();

        assert!(matches!(
            interaction.submission_failed(id),
            Some(SubmissionFailure::RestoreDraft { .. })
        ));
        assert_eq!(interaction.layer, CanvasLayer::ApprovalPrompt);
        interaction.leave_approval();
        assert_eq!(interaction.visible_draft(), Some("first"));
    }

    #[test]
    fn attachments_keep_an_empty_draft_visible_and_are_correlated_to_submission() {
        let mut interaction = CanvasInteraction::new();
        interaction.set_conversation_has_attachments(true);

        assert_eq!(interaction.layer, CanvasLayer::Draft);
        assert_eq!(interaction.visible_draft(), Some(""));
        let id = interaction
            .begin_submission_with_attachments(String::new(), "user:media".to_string(), vec![7, 9])
            .expect("media-only submission should start");

        assert_eq!(interaction.layer, CanvasLayer::Moment);
        assert_eq!(
            interaction.submission_failed(id),
            Some(SubmissionFailure::RestoreDraft {
                moment_id: "user:media".to_string(),
                text: String::new(),
                attachment_ids: vec![7, 9],
            })
        );
        assert_eq!(interaction.visible_draft(), Some(""));
    }

    #[test]
    fn approval_results_are_correlated_and_failures_restore_the_decision() {
        let mut interaction = CanvasInteraction::new();
        interaction.enter_approval();
        interaction.on_input("allow once".to_string());
        assert!(interaction
            .begin_approval_submission("request-1".to_string(), "allow once".to_string(),));
        assert!(!interaction.approval_submission_accepted("request-2"));
        assert_eq!(
            interaction.approval_submission_failed("request-1"),
            Some(ApprovalSubmissionFailure::RestoreDecision {
                text: "allow once".to_string(),
            })
        );
        assert_eq!(interaction.visible_draft(), Some("allow once"));
    }

    #[test]
    fn approval_failure_does_not_overwrite_a_newer_decision() {
        let mut interaction = CanvasInteraction::new();
        interaction.enter_approval();
        interaction.on_input("allow once".to_string());
        assert!(interaction
            .begin_approval_submission("request-1".to_string(), "allow once".to_string(),));
        interaction.on_input("deny".to_string());

        assert_eq!(
            interaction.approval_submission_failed("request-1"),
            Some(ApprovalSubmissionFailure::PreserveNewerDecision)
        );
        assert_eq!(interaction.visible_draft(), Some("deny"));
    }
}
