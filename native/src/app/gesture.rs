use std::time::{Duration, Instant};

use gpui::Context;
use gsv_vision_control::{
    ControlStatus, GestureCandidate, GestureIntent, GestureProgress, GestureState, LifecycleState,
};

use crate::vision_debug::{VisionContext, VisionEvent};

use super::{GsvApp, VoiceGestureStatus};

const MAX_GESTURE_INTENT_AGE: Duration = Duration::from_secs(1);
const MAX_GESTURE_STATUS_AGE: Duration = Duration::from_secs(1);

const VOICE_GESTURES_DISABLED: &str = "LISTENING · SPEAK NOW · PRESS AGAIN TO FINISH";
const VOICE_GESTURES_STARTING: &str = "LISTENING · GESTURES STARTING";
const VOICE_GESTURES_UNAVAILABLE: &str = "LISTENING · GESTURES UNAVAILABLE · PRESS AGAIN TO FINISH";
const VOICE_GESTURES_NEED_READY: &str = "LISTENING · SHOW TWO OPEN PALMS";
const VOICE_GESTURES_READY: &str = "LISTENING · GESTURES READY";
const VOICE_GESTURES_HELD: &str = "LISTENING · SEND HELD · SHOW TWO OPEN PALMS";
const VOICE_GESTURES_HELD_UNAVAILABLE: &str = "LISTENING · SEND HELD · GESTURES UNAVAILABLE";
const VOICE_GESTURE_ARMING: &str = "LISTENING · ARMING GESTURES";
const VOICE_GESTURE_HOLDING: &str = "LISTENING · REQUESTING SEND HOLD";
const VOICE_GESTURE_RELEASING: &str = "LISTENING · PREPARING TO RELEASE SEND HOLD";
const VOICE_GESTURE_SENDING: &str = "LISTENING · PREPARING TO SEND";

impl GsvApp {
    /// Gives the helper a request-scoped action lease only after transcription
    /// has authoritatively entered its listening phase.
    pub(super) fn enable_vision_for_voice(&mut self, request_id: u64) {
        if !self.voice_request_accepts_gestures(request_id) {
            return;
        }
        if self.vision_voice_request_id != Some(request_id) {
            self.vision_voice_request_id = Some(request_id);
            self.clear_voice_gesture_status();
        }
        self.sync_vision_context();
    }

    /// Invalidates the action lease before the voice request is cleared. A
    /// queued event still carries the old request ID and is rejected below.
    pub(super) fn disable_vision_for_voice(&mut self, request_id: u64) {
        if self
            .vision_gesture_status
            .is_some_and(|status| status.request_id == request_id)
        {
            self.clear_voice_gesture_status();
        }
        if self.vision_voice_request_id != Some(request_id) {
            return;
        }
        self.vision_voice_request_id = None;
        self.sync_vision_context();
    }

    pub(super) fn handle_vision_event(&mut self, event: VisionEvent, cx: &mut Context<Self>) {
        match event {
            VisionEvent::Lifecycle(state) => {
                self.vision_lifecycle = Some(state);
                if state == LifecycleState::Ready {
                    self.sync_vision_context();
                } else {
                    self.clear_voice_gesture_status();
                }
                // Failure never synthesizes a hold release. Presentation is
                // recomputed from the app-owned hold and helper availability.
                self.refresh_listening_voice_notice();
                cx.notify();
            }
            VisionEvent::Status {
                sequence,
                received_at,
                status,
            } => {
                if sequence == 0 || sequence <= self.vision_status_sequence {
                    return;
                }
                self.vision_status_sequence = sequence;
                if Instant::now().saturating_duration_since(received_at) > MAX_GESTURE_STATUS_AGE {
                    if matches!(
                        status,
                        ControlStatus::Active {
                            voice_request_id,
                            ..
                        } if self.vision_voice_request_id == Some(voice_request_id)
                            && self.active_voice_request_id() == Some(voice_request_id)
                            && self.voice_request_accepts_gestures(voice_request_id)
                    ) {
                        // A stale latest snapshot cannot replace current
                        // presentation, but it proves any older claim is no
                        // longer trustworthy. Keep the voice action state and
                        // fall back to the bounded synchronization notice.
                        self.clear_voice_gesture_status();
                        self.refresh_listening_voice_notice();
                        cx.notify();
                    }
                    return;
                }
                match status {
                    ControlStatus::Disabled => self.clear_voice_gesture_status(),
                    ControlStatus::Active {
                        voice_request_id,
                        state,
                        progress,
                    } => {
                        if self.vision_voice_request_id != Some(voice_request_id)
                            || self.active_voice_request_id() != Some(voice_request_id)
                            || !self.voice_request_accepts_gestures(voice_request_id)
                        {
                            return;
                        }
                        self.set_voice_gesture_status(
                            VoiceGestureStatus {
                                request_id: voice_request_id,
                                sequence,
                                received_at,
                                state,
                                progress,
                            },
                            cx,
                        );
                    }
                }
                self.refresh_listening_voice_notice();
                cx.notify();
            }
            VisionEvent::Intent {
                sequence,
                received_at,
                voice_request_id,
                intent,
            } => {
                if Instant::now().saturating_duration_since(received_at) > MAX_GESTURE_INTENT_AGE
                    || self.vision_voice_request_id != Some(voice_request_id)
                    || self.active_voice_request_id() != Some(voice_request_id)
                {
                    return;
                }
                let changed = match intent {
                    GestureIntent::Hold => {
                        let changed = self.gesture_hold_dictation(cx);
                        if changed {
                            self.set_voice_gesture_status(
                                VoiceGestureStatus {
                                    request_id: voice_request_id,
                                    sequence,
                                    received_at,
                                    state: GestureState::Holding,
                                    progress: None,
                                },
                                cx,
                            );
                            self.refresh_listening_voice_notice();
                        }
                        changed
                    }
                    GestureIntent::ReleaseHold => {
                        let changed = self.gesture_release_dictation_hold(cx);
                        if changed {
                            self.set_voice_gesture_status(
                                VoiceGestureStatus {
                                    request_id: voice_request_id,
                                    sequence,
                                    received_at,
                                    state: GestureState::Ready,
                                    progress: None,
                                },
                                cx,
                            );
                            self.refresh_listening_voice_notice();
                        }
                        changed
                    }
                    GestureIntent::Send => {
                        let changed = self.gesture_send_dictation_now(cx);
                        if changed {
                            self.voice_notice = Some("FINISHING VOICE INPUT · SENDING".to_string());
                            self.vision_voice_request_id = None;
                        }
                        changed
                    }
                };
                if changed {
                    self.sync_vision_context();
                    cx.notify();
                }
            }
        }
    }

    fn sync_vision_context(&self) {
        let Some(sender) = &self.vision_context else {
            return;
        };
        let context = self
            .vision_voice_request_id
            .filter(|request_id| self.active_voice_request_id() == Some(*request_id))
            .map_or_else(VisionContext::disabled, |request_id| {
                VisionContext::listening(request_id, self.dictation_is_gesture_held())
            });
        let _ = sender.set_context(context);
    }

    pub(super) fn listening_voice_notice(&self, request_id: u64) -> &'static str {
        let status = self.fresh_voice_gesture_status(request_id);
        let state = status.map(|status| status.state);
        let progress = self.voice_gesture_progress(request_id);
        let held = self.dictation_is_gesture_held();

        if self.vision_context.is_none() {
            return VOICE_GESTURES_DISABLED;
        }
        if self.vision_lifecycle != Some(LifecycleState::Ready) {
            return if held {
                VOICE_GESTURES_HELD_UNAVAILABLE
            } else if self.vision_lifecycle.is_none() {
                VOICE_GESTURES_STARTING
            } else {
                VOICE_GESTURES_UNAVAILABLE
            };
        }
        if held {
            if progress
                .is_some_and(|progress| progress.candidate() == GestureCandidate::ReleaseHold)
            {
                return VOICE_GESTURE_RELEASING;
            }
            return VOICE_GESTURES_HELD;
        }
        if let Some(progress) = progress {
            return match progress.candidate() {
                GestureCandidate::Arm => VOICE_GESTURE_ARMING,
                GestureCandidate::Hold => VOICE_GESTURE_HOLDING,
                GestureCandidate::Send => VOICE_GESTURE_SENDING,
                // A release candidate cannot describe the app-owned state
                // until Desktop has accepted the reliable Hold intent.
                GestureCandidate::ReleaseHold => VOICE_GESTURES_NEED_READY,
            };
        }
        match state {
            Some(GestureState::NeedsReady) => VOICE_GESTURES_NEED_READY,
            Some(GestureState::Ready) => VOICE_GESTURES_READY,
            // Status never synthesizes the app-owned hold. The helper will
            // reconcile after the explicit ready pose; until then, guide the
            // user toward that safe synchronization edge.
            Some(GestureState::Holding) => VOICE_GESTURES_NEED_READY,
            None => VOICE_GESTURES_STARTING,
        }
    }

    /// Returns only fresh, request-fenced presentation progress. The helper
    /// owns dwell timing; Desktop consumes the normalized value without
    /// deriving acceptance or turning it into an action.
    pub(super) fn visible_voice_gesture_progress(&self) -> Option<GestureProgress> {
        self.voice_gesture_progress(self.vision_voice_request_id?)
    }

    fn voice_gesture_progress(&self, request_id: u64) -> Option<GestureProgress> {
        let status = self.fresh_voice_gesture_status(request_id)?;
        if self.vision_lifecycle != Some(LifecycleState::Ready)
            || self.vision_voice_request_id != Some(request_id)
            || self.active_voice_request_id() != Some(request_id)
            || !self.voice_request_accepts_gestures(request_id)
        {
            return None;
        }
        let progress = status.progress?;
        if !progress.is_compatible_with(status.state) {
            return None;
        }
        let state_matches_app_hold = match status.state {
            GestureState::NeedsReady | GestureState::Ready => !self.dictation_is_gesture_held(),
            GestureState::Holding => self.dictation_is_gesture_held(),
        };
        state_matches_app_hold.then_some(progress)
    }

    fn fresh_voice_gesture_status(&self, request_id: u64) -> Option<VoiceGestureStatus> {
        self.vision_gesture_status.filter(|status| {
            status.request_id == request_id
                && Instant::now().saturating_duration_since(status.received_at)
                    < MAX_GESTURE_STATUS_AGE
        })
    }

    /// Stores one presentation snapshot and owns its expiry. The timer is
    /// replaced by every newer snapshot, while request, sequence, and receipt
    /// time fences prevent an older task from clearing newer presentation.
    /// Expiry never changes the app-owned voice draft or gesture hold.
    fn set_voice_gesture_status(&mut self, status: VoiceGestureStatus, cx: &mut Context<Self>) {
        let age = Instant::now().saturating_duration_since(status.received_at);
        let expires_in = MAX_GESTURE_STATUS_AGE.saturating_sub(age);
        let request_id = status.request_id;
        let sequence = status.sequence;
        let received_at = status.received_at;
        self.vision_gesture_status = Some(status);

        let timer = cx.background_executor().timer(expires_in);
        self.vision_gesture_expiry_task = Some(cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |this, cx| {
                let still_current = this.vision_gesture_status.is_some_and(|current| {
                    current.request_id == request_id
                        && current.sequence == sequence
                        && current.received_at == received_at
                });
                if still_current {
                    this.vision_gesture_status = None;
                    this.refresh_listening_voice_notice();
                    cx.notify();
                }
            });
        }));
    }

    fn clear_voice_gesture_status(&mut self) {
        self.vision_gesture_status = None;
        self.vision_gesture_expiry_task = None;
    }

    fn refresh_listening_voice_notice(&mut self) {
        let Some(request_id) = self
            .vision_voice_request_id
            .filter(|request_id| self.voice_request_accepts_gestures(*request_id))
        else {
            return;
        };
        self.voice_notice = Some(self.listening_voice_notice(request_id).to_string());
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{AppContext as _, TestAppContext, WindowOptions};
    use gpui_component::Root;

    use crate::app::microphone::VoiceDraft;

    use super::*;

    #[test]
    fn protocol_intents_are_explicit_not_toggles() {
        assert_ne!(GestureIntent::Hold, GestureIntent::ReleaseHold);
        assert_ne!(GestureIntent::Send, GestureIntent::Hold);
    }

    #[gpui::test]
    fn gesture_feedback_survives_partial_transcript_updates(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::app::bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });
        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.voice_draft = Some(VoiceDraft::new(
                        73,
                        String::new(),
                        String::new(),
                        String::new(),
                    ));

                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::State {
                            request_id: 73,
                            phase: crate::transcription::VoicePhase::Listening,
                            progress: None,
                        },
                        window,
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_DISABLED));

                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.handle_vision_event(VisionEvent::Lifecycle(LifecycleState::Ready), cx);
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_STARTING));

                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 2,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 73,
                                state: GestureState::Ready,
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_READY));

                    let send_progress = GestureProgress::new(GestureCandidate::Send, 625)
                        .expect("test progress is in range");
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 3,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 73,
                                state: GestureState::Ready,
                                progress: Some(send_progress),
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_SENDING));
                    assert_eq!(app.visible_voice_gesture_progress(), Some(send_progress));

                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::Partial {
                            request_id: 73,
                            revision: 1,
                            committed: "hello".to_string(),
                            tentative: " world".to_string(),
                        },
                        window,
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_SENDING));
                    assert_eq!(app.visible_voice_gesture_progress(), Some(send_progress));

                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 4,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 73,
                                state: GestureState::Ready,
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_READY));
                    assert!(app.visible_voice_gesture_progress().is_none());
                });
            })
            .expect("window remains open");
        cx.run_until_parked();

        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_READY));
            assert_eq!(app.input.read(cx).value().as_ref(), "hello world");
            assert!(app.vision_gesture_status.is_some_and(|status| {
                status.request_id == 73
                    && status.sequence == 4
                    && status.state == GestureState::Ready
                    && status.progress.is_none()
            }));
        });
    }

    #[gpui::test]
    fn mismatched_status_is_ignored_and_stale_current_status_clears_feedback(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::app::bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });
        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.vision_lifecycle = Some(LifecycleState::Ready);
                    app.voice_draft = Some(VoiceDraft::new(
                        74,
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::State {
                            request_id: 74,
                            phase: crate::transcription::VoicePhase::Listening,
                            progress: None,
                        },
                        window,
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 10,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::Ready,
                                progress: None,
                            },
                        },
                        cx,
                    );

                    let stale = Instant::now()
                        .checked_sub(MAX_GESTURE_STATUS_AGE + Duration::from_millis(1))
                        .expect("test instant supports a short subtraction");
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 11,
                            received_at: stale,
                            status: ControlStatus::Active {
                                voice_request_id: 75,
                                state: GestureState::NeedsReady,
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_READY));
                    assert!(app.vision_gesture_status.is_some_and(|status| {
                        status.request_id == 74
                            && status.sequence == 10
                            && status.state == GestureState::Ready
                            && status.progress.is_none()
                    }));

                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 12,
                            received_at: stale,
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::NeedsReady,
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_STARTING));
                    assert!(app.vision_gesture_status.is_none());
                    assert_eq!(app.vision_status_sequence, 12);

                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 13,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::NeedsReady,
                                progress: Some(
                                    GestureProgress::new(GestureCandidate::Send, 500)
                                        .expect("test progress is in range"),
                                ),
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_NEED_READY));
                    assert!(app.visible_voice_gesture_progress().is_none());

                    // Helper state explains presentation but cannot latch the
                    // app-owned action state.
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 14,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::Holding,
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert!(!app.dictation_is_gesture_held());
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_NEED_READY));

                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::Cancelled { request_id: 74 },
                        window,
                        cx,
                    );
                    assert!(app.voice_draft.is_none());
                    assert!(app.vision_voice_request_id.is_none());
                    assert!(app.vision_gesture_status.is_none());
                    assert!(app.voice_notice.is_none());
                });
            })
            .expect("window remains open");
    }

    #[gpui::test]
    fn stale_intents_and_helper_loss_cannot_mutate_or_release_a_voice_request(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::app::bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });
        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, _, cx| {
                app.update(cx, |app, cx| {
                    let stale = Instant::now()
                        .checked_sub(MAX_GESTURE_INTENT_AGE + Duration::from_millis(1))
                        .expect("test instant supports a short subtraction");
                    app.voice_draft = Some(VoiceDraft::new(
                        72,
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.vision_lifecycle = Some(LifecycleState::Ready);
                    app.vision_voice_request_id = Some(72);

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            voice_request_id: 71,
                            intent: GestureIntent::Hold,
                        },
                        cx,
                    );
                    assert!(!app.dictation_is_gesture_held());

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 2,
                            received_at: stale,
                            voice_request_id: 72,
                            intent: GestureIntent::Hold,
                        },
                        cx,
                    );
                    assert!(!app.dictation_is_gesture_held());
                    assert!(app.voice_request_accepts_gestures(72));

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 3,
                            received_at: stale,
                            voice_request_id: 72,
                            intent: GestureIntent::Send,
                        },
                        cx,
                    );
                    assert!(app.voice_request_accepts_gestures(72));

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 4,
                            received_at: Instant::now(),
                            voice_request_id: 72,
                            intent: GestureIntent::Hold,
                        },
                        cx,
                    );
                    assert!(app.dictation_is_gesture_held());

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 5,
                            received_at: stale,
                            voice_request_id: 72,
                            intent: GestureIntent::ReleaseHold,
                        },
                        cx,
                    );
                    assert!(app.dictation_is_gesture_held());

                    let release_progress = GestureProgress::new(GestureCandidate::ReleaseHold, 500)
                        .expect("test progress is in range");
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 6,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 72,
                                state: GestureState::Holding,
                                progress: Some(release_progress),
                            },
                        },
                        cx,
                    );
                    assert!(app.dictation_is_gesture_held());
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_RELEASING));
                    assert_eq!(app.visible_voice_gesture_progress(), Some(release_progress));

                    app.handle_vision_event(
                        VisionEvent::Lifecycle(LifecycleState::Interrupted),
                        cx,
                    );
                    assert!(app.dictation_is_gesture_held());
                    assert!(app.visible_voice_gesture_progress().is_none());
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("LISTENING · SEND HELD · GESTURES UNAVAILABLE")
                    );
                });
            })
            .expect("window remains open");
    }

    #[gpui::test]
    fn gesture_progress_expires_without_releasing_the_app_owned_hold(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::app::bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });
        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        let release_progress = GestureProgress::new(GestureCandidate::ReleaseHold, 500)
            .expect("test progress is in range");

        window_handle
            .update(cx, |_, _, cx| {
                app.update(cx, |app, cx| {
                    app.voice_draft = Some(VoiceDraft::new(
                        72,
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.vision_lifecycle = Some(LifecycleState::Ready);
                    app.vision_voice_request_id = Some(72);
                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            voice_request_id: 72,
                            intent: GestureIntent::Hold,
                        },
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 2,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 72,
                                state: GestureState::Holding,
                                progress: Some(release_progress),
                            },
                        },
                        cx,
                    );

                    assert!(app.dictation_is_gesture_held());
                    assert_eq!(app.visible_voice_gesture_progress(), Some(release_progress));
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_RELEASING));
                    assert!(!VOICE_GESTURE_RELEASING.contains("RELEASING"));
                });
            })
            .expect("window remains open");
        cx.run_until_parked();

        cx.executor()
            .advance_clock(MAX_GESTURE_STATUS_AGE + Duration::from_millis(1));
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.vision_gesture_status.is_none());
            assert!(app.visible_voice_gesture_progress().is_none());
            assert!(app.dictation_is_gesture_held());
            assert!(app.voice_request_accepts_gestures(72));
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_HELD));
        });
    }

    #[gpui::test]
    fn old_expiry_cannot_clear_a_superseding_status_or_voice_request(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::app::bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });
        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        let send_progress =
            GestureProgress::new(GestureCandidate::Send, 300).expect("test progress is in range");
        let hold_progress =
            GestureProgress::new(GestureCandidate::Hold, 600).expect("test progress is in range");
        let arm_progress =
            GestureProgress::new(GestureCandidate::Arm, 450).expect("test progress is in range");

        window_handle
            .update(cx, |_, _, cx| {
                app.update(cx, |app, cx| {
                    app.voice_draft = Some(VoiceDraft::new(
                        81,
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.vision_lifecycle = Some(LifecycleState::Ready);
                    app.vision_voice_request_id = Some(81);
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 10,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 81,
                                state: GestureState::Ready,
                                progress: Some(send_progress),
                            },
                        },
                        cx,
                    );
                });
            })
            .expect("window remains open");
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(400));
        cx.run_until_parked();

        window_handle
            .update(cx, |_, _, cx| {
                app.update(cx, |app, cx| {
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 11,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 81,
                                state: GestureState::Ready,
                                progress: Some(hold_progress),
                            },
                        },
                        cx,
                    );
                });
            })
            .expect("window remains open");
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(700));
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.visible_voice_gesture_progress(), Some(hold_progress));
            assert_eq!(
                app.vision_gesture_status.map(|status| status.sequence),
                Some(11)
            );
        });

        window_handle
            .update(cx, |_, _, cx| {
                app.update(cx, |app, cx| {
                    app.voice_draft = Some(VoiceDraft::new(
                        82,
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                    app.enable_vision_for_voice(82);
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 12,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 82,
                                state: GestureState::NeedsReady,
                                progress: Some(arm_progress),
                            },
                        },
                        cx,
                    );
                });
            })
            .expect("window remains open");
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(400));
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.visible_voice_gesture_progress(), Some(arm_progress));
            assert_eq!(
                app.vision_gesture_status.map(|status| status.request_id),
                Some(82)
            );
        });

        cx.executor().advance_clock(Duration::from_millis(601));
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.vision_gesture_status.is_none());
            assert!(app.visible_voice_gesture_progress().is_none());
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_STARTING));
        });
    }
}
