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
const VOICE_GESTURES_DISARMED: &str = "LISTENING · SHOW TWO OPEN PALMS";
const VOICE_GESTURES_ARMED: &str = "LISTENING · GESTURES ARMED";
const VOICE_GESTURES_MUTED_ARMED: &str = "LISTENING · MICROPHONE MUTED · GESTURES ARMED";
const VOICE_GESTURES_MUTED_NEED_READY: &str = "LISTENING · MICROPHONE MUTED · SHOW TWO OPEN PALMS";
const VOICE_GESTURES_MUTED_UNAVAILABLE: &str =
    "LISTENING · MICROPHONE MUTED · GESTURES UNAVAILABLE";
const VOICE_GESTURE_ARMING: &str = "LISTENING · ARMING GESTURES";
const VOICE_GESTURE_DISARMING: &str = "LISTENING · DISARMING GESTURES";
const VOICE_GESTURE_SENDING: &str = "LISTENING · PREPARING TO SEND";
const VOICE_GESTURE_MUTING: &str = "LISTENING · MUTING MICROPHONE";
const VOICE_GESTURE_UNMUTING: &str = "LISTENING · UNMUTING MICROPHONE";

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
                if state != LifecycleState::Ready {
                    // A helper lifecycle failure revokes arming, but cannot
                    // synthesize an unrelated microphone unmute.
                    self.gesture_disarm_dictation(cx);
                    self.clear_voice_gesture_status();
                }
                self.sync_vision_context();
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
                sequence: _,
                received_at,
                voice_request_id,
                intent,
            } => {
                if self.vision_voice_request_id != Some(voice_request_id)
                    || self.active_voice_request_id() != Some(voice_request_id)
                {
                    return;
                }

                let eligible = Instant::now().saturating_duration_since(received_at)
                    <= MAX_GESTURE_INTENT_AGE
                    && self.vision_lifecycle == Some(LifecycleState::Ready)
                    && self.voice_request_accepts_gestures(voice_request_id);
                if eligible {
                    match intent {
                        GestureIntent::Arm => {
                            self.gesture_arm_dictation(cx);
                        }
                        GestureIntent::Disarm => {
                            self.gesture_disarm_dictation(cx);
                        }
                        GestureIntent::Send => {
                            if self.gesture_send_dictation_now(cx) {
                                self.voice_notice =
                                    Some("FINISHING VOICE INPUT · SENDING".to_string());
                            }
                        }
                        GestureIntent::Mute => {
                            self.gesture_set_dictation_muted(true, cx);
                        }
                        GestureIntent::Unmute => {
                            self.gesture_set_dictation_muted(false, cx);
                        }
                    }
                }

                // A reliable intent supersedes its older explanatory status.
                // Rejected and idempotent intents need an explicit absolute
                // context replay so the helper can leave AwaitingAuthority.
                // An accepted mute transition is the one exception: replaying
                // the old bit would reject it before transcription acks.
                self.clear_voice_gesture_status();
                if self.dictation_pending_mute().is_none() {
                    self.reassert_vision_context();
                }
                self.refresh_listening_voice_notice();
                cx.notify();
            }
        }
    }

    pub(super) fn sync_vision_context(&self) {
        let Some(sender) = &self.vision_context else {
            return;
        };
        let _ = sender.set_context(self.current_vision_context());
    }

    fn reassert_vision_context(&self) {
        let Some(sender) = &self.vision_context else {
            return;
        };
        let _ = sender.reassert_context(self.current_vision_context());
    }

    fn current_vision_context(&self) -> VisionContext {
        self.vision_voice_request_id
            .filter(|request_id| self.active_voice_request_id() == Some(*request_id))
            .map_or_else(VisionContext::disabled, |request_id| {
                VisionContext::listening(
                    request_id,
                    self.dictation_gestures_are_armed(),
                    self.dictation_is_muted(),
                )
            })
    }

    pub(super) fn listening_voice_notice(&self, request_id: u64) -> &'static str {
        if let Some(pending_mute) = self.dictation_pending_mute() {
            return if pending_mute {
                VOICE_GESTURE_MUTING
            } else {
                VOICE_GESTURE_UNMUTING
            };
        }

        let progress = self.voice_gesture_progress(request_id);
        let armed = self.dictation_gestures_are_armed();
        let muted = self.dictation_is_muted();

        if self.vision_context.is_none() {
            return if muted {
                VOICE_GESTURES_MUTED_UNAVAILABLE
            } else if self.vision_lifecycle.is_some() {
                VOICE_GESTURES_UNAVAILABLE
            } else {
                VOICE_GESTURES_DISABLED
            };
        }
        if self.vision_lifecycle != Some(LifecycleState::Ready) {
            return if muted {
                VOICE_GESTURES_MUTED_UNAVAILABLE
            } else if self.vision_lifecycle.is_none() {
                VOICE_GESTURES_STARTING
            } else {
                VOICE_GESTURES_UNAVAILABLE
            };
        }
        if !self.dictation_mute_state_is_authoritative() {
            return VOICE_GESTURES_STARTING;
        }
        if let Some(progress) = progress {
            return match progress.candidate() {
                GestureCandidate::Arm => VOICE_GESTURE_ARMING,
                GestureCandidate::Disarm => VOICE_GESTURE_DISARMING,
                GestureCandidate::Send => VOICE_GESTURE_SENDING,
                GestureCandidate::Mute => VOICE_GESTURE_MUTING,
                GestureCandidate::Unmute => VOICE_GESTURE_UNMUTING,
            };
        }
        if muted {
            if armed {
                VOICE_GESTURES_MUTED_ARMED
            } else {
                VOICE_GESTURES_MUTED_NEED_READY
            }
        } else if armed {
            VOICE_GESTURES_ARMED
        } else {
            VOICE_GESTURES_DISARMED
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
            || self.dictation_pending_mute().is_some()
        {
            return None;
        }
        let progress = status.progress?;
        let app_state = GestureState::new(
            self.dictation_gestures_are_armed(),
            self.dictation_is_muted(),
        );
        if status.state != app_state || !progress.is_compatible_with(status.state) {
            return None;
        }
        Some(progress)
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
    /// Expiry never changes the app-owned voice gesture or mute state.
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

    pub(super) fn clear_voice_gesture_status(&mut self) {
        self.vision_gesture_status = None;
        self.vision_gesture_expiry_task = None;
    }

    pub(super) fn refresh_listening_voice_notice(&mut self) {
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
        assert_ne!(GestureIntent::Arm, GestureIntent::Disarm);
        assert_ne!(GestureIntent::Mute, GestureIntent::Unmute);
        assert_ne!(GestureIntent::Send, GestureIntent::Mute);
    }

    #[gpui::test]
    fn opted_in_vision_startup_failure_is_visible_while_listening(cx: &mut TestAppContext) {
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
                let view = cx.new(|cx| {
                    GsvApp::new_with_vision(
                        window,
                        cx,
                        client,
                        true,
                        false,
                        true,
                        crate::app::VisionStartup::Unavailable,
                    )
                });
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
                    assert!(app.vision_context.is_none());
                    assert_eq!(app.vision_lifecycle, Some(LifecycleState::Interrupted));
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

                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some(VOICE_GESTURES_UNAVAILABLE)
                    );
                });
            })
            .expect("window remains open");
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
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::MuteState {
                            request_id: 73,
                            revision: 0,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_DISABLED));

                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.handle_vision_event(VisionEvent::Lifecycle(LifecycleState::Ready), cx);
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_DISARMED));

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 2,
                            received_at: Instant::now(),
                            voice_request_id: 73,
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));

                    let send_progress = GestureProgress::new(GestureCandidate::Send, 625)
                        .expect("test progress is in range");
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 3,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 73,
                                state: GestureState::new(true, false),
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
                                state: GestureState::new(true, false),
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));
                    assert!(app.visible_voice_gesture_progress().is_none());
                });
            })
            .expect("window remains open");
        cx.run_until_parked();

        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));
            assert_eq!(app.input.read(cx).value().as_ref(), "hello world");
            assert!(app.vision_gesture_status.is_some_and(|status| {
                status.request_id == 73
                    && status.sequence == 4
                    && status.state == GestureState::new(true, false)
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
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::MuteState {
                            request_id: 74,
                            revision: 0,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 9,
                            received_at: Instant::now(),
                            voice_request_id: 74,
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 10,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::new(true, false),
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
                                state: GestureState::new(false, false),
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));
                    assert!(app.vision_gesture_status.is_some_and(|status| {
                        status.request_id == 74
                            && status.sequence == 10
                            && status.state == GestureState::new(true, false)
                            && status.progress.is_none()
                    }));

                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 12,
                            received_at: stale,
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::new(false, false),
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));
                    assert!(app.vision_gesture_status.is_none());
                    assert_eq!(app.vision_status_sequence, 12);

                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 13,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::new(false, false),
                                progress: Some(
                                    GestureProgress::new(GestureCandidate::Send, 500)
                                        .expect("test progress is in range"),
                                ),
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));
                    assert!(app.visible_voice_gesture_progress().is_none());

                    // Helper status is presentation-only and cannot mute the
                    // app-owned voice request.
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 14,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::new(true, true),
                                progress: None,
                            },
                        },
                        cx,
                    );
                    assert!(!app.dictation_is_muted());
                    assert!(app.dictation_gestures_are_armed());
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));

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
    fn stale_intents_cannot_mutate_and_lifecycle_failure_disarms(cx: &mut TestAppContext) {
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
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::State {
                            request_id: 72,
                            phase: crate::transcription::VoicePhase::Listening,
                            progress: None,
                        },
                        window,
                        cx,
                    );
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::MuteState {
                            request_id: 72,
                            revision: 0,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    let context_revision = app
                        .vision_context
                        .as_ref()
                        .expect("test context")
                        .revision_for_test();

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            voice_request_id: 71,
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    assert!(!app.dictation_gestures_are_armed());
                    assert_eq!(
                        app.vision_context
                            .as_ref()
                            .expect("test context")
                            .revision_for_test(),
                        context_revision
                    );

                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 2,
                            received_at: stale,
                            voice_request_id: 72,
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    assert!(!app.dictation_gestures_are_armed());
                    assert!(app.voice_request_accepts_gestures(72));
                    assert_ne!(
                        app.vision_context
                            .as_ref()
                            .expect("test context")
                            .revision_for_test(),
                        context_revision
                    );

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
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    assert!(app.dictation_gestures_are_armed());

                    // Replaying an explicit intent is idempotent.
                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 5,
                            received_at: Instant::now(),
                            voice_request_id: 72,
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    assert!(app.dictation_gestures_are_armed());

                    let disarm_progress = GestureProgress::new(GestureCandidate::Disarm, 500)
                        .expect("test progress is in range");
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 6,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 72,
                                state: GestureState::new(true, false),
                                progress: Some(disarm_progress),
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_DISARMING));
                    assert_eq!(app.visible_voice_gesture_progress(), Some(disarm_progress));

                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::MuteState {
                            request_id: 72,
                            revision: 1,
                            muted: true,
                        },
                        window,
                        cx,
                    );
                    assert!(app.dictation_is_muted());
                    assert!(app.dictation_gestures_are_armed());

                    let unmute_progress = GestureProgress::new(GestureCandidate::Unmute, 500)
                        .expect("test progress is in range");
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 7,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 72,
                                state: GestureState::new(true, true),
                                progress: Some(unmute_progress),
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.visible_voice_gesture_progress(), Some(unmute_progress));
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_UNMUTING));

                    app.handle_vision_event(
                        VisionEvent::Lifecycle(LifecycleState::Interrupted),
                        cx,
                    );
                    assert!(!app.dictation_gestures_are_armed());
                    assert!(app.dictation_is_muted());
                    assert!(app.visible_voice_gesture_progress().is_none());
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some(VOICE_GESTURES_MUTED_UNAVAILABLE)
                    );
                });
            })
            .expect("window remains open");
    }

    #[gpui::test]
    fn gesture_progress_expires_without_disarming_the_voice_request(cx: &mut TestAppContext) {
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
        let disarm_progress =
            GestureProgress::new(GestureCandidate::Disarm, 500).expect("test progress is in range");

        window_handle
            .update(cx, |_, window, cx| {
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
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::State {
                            request_id: 72,
                            phase: crate::transcription::VoicePhase::Listening,
                            progress: None,
                        },
                        window,
                        cx,
                    );
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::MuteState {
                            request_id: 72,
                            revision: 0,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            voice_request_id: 72,
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 2,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 72,
                                state: GestureState::new(true, false),
                                progress: Some(disarm_progress),
                            },
                        },
                        cx,
                    );

                    assert!(app.dictation_gestures_are_armed());
                    assert_eq!(app.visible_voice_gesture_progress(), Some(disarm_progress));
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_DISARMING));
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
            assert!(app.dictation_gestures_are_armed());
            assert!(app.voice_request_accepts_gestures(72));
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_ARMED));
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
        let mute_progress =
            GestureProgress::new(GestureCandidate::Mute, 600).expect("test progress is in range");
        let arm_progress =
            GestureProgress::new(GestureCandidate::Arm, 450).expect("test progress is in range");

        window_handle
            .update(cx, |_, window, cx| {
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
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::State {
                            request_id: 81,
                            phase: crate::transcription::VoicePhase::Listening,
                            progress: None,
                        },
                        window,
                        cx,
                    );
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::MuteState {
                            request_id: 81,
                            revision: 0,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            voice_request_id: 81,
                            intent: GestureIntent::Arm,
                        },
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 10,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 81,
                                state: GestureState::new(true, false),
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
                                state: GestureState::new(true, false),
                                progress: Some(mute_progress),
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
            assert_eq!(app.visible_voice_gesture_progress(), Some(mute_progress));
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURE_MUTING));
            assert_eq!(
                app.vision_gesture_status.map(|status| status.sequence),
                Some(11)
            );
        });

        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.voice_draft = Some(VoiceDraft::new(
                        82,
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::State {
                            request_id: 82,
                            phase: crate::transcription::VoicePhase::Listening,
                            progress: None,
                        },
                        window,
                        cx,
                    );
                    app.handle_voice_event(
                        crate::transcription::VoiceEvent::MuteState {
                            request_id: 82,
                            revision: 0,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 12,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 82,
                                state: GestureState::new(false, false),
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
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_DISARMED));
        });
    }
}
