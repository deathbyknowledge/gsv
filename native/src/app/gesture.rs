use std::time::{Duration, Instant};

use gpui::Context;
use gsv_vision_control::{ControlStatus, GestureIntent, GestureState, LifecycleState};

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

impl GsvApp {
    /// Gives the helper a request-scoped action lease only after transcription
    /// has authoritatively entered its listening phase.
    pub(super) fn enable_vision_for_voice(&mut self, request_id: u64) {
        if !self.voice_request_accepts_gestures(request_id) {
            return;
        }
        if self.vision_voice_request_id != Some(request_id) {
            self.vision_voice_request_id = Some(request_id);
            self.vision_gesture_status = None;
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
            self.vision_gesture_status = None;
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
                    self.vision_gesture_status = None;
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
                        self.vision_gesture_status = None;
                        self.refresh_listening_voice_notice();
                        cx.notify();
                    }
                    return;
                }
                match status {
                    ControlStatus::Disabled => self.vision_gesture_status = None,
                    ControlStatus::Active {
                        voice_request_id,
                        state,
                    } => {
                        if self.vision_voice_request_id != Some(voice_request_id)
                            || self.active_voice_request_id() != Some(voice_request_id)
                            || !self.voice_request_accepts_gestures(voice_request_id)
                        {
                            return;
                        }
                        self.vision_gesture_status = Some(VoiceGestureStatus {
                            request_id: voice_request_id,
                            state,
                        });
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
                            self.vision_gesture_status = Some(VoiceGestureStatus {
                                request_id: voice_request_id,
                                state: GestureState::Holding,
                            });
                            self.refresh_listening_voice_notice();
                        }
                        changed
                    }
                    GestureIntent::ReleaseHold => {
                        let changed = self.gesture_release_dictation_hold(cx);
                        if changed {
                            self.vision_gesture_status = Some(VoiceGestureStatus {
                                request_id: voice_request_id,
                                state: GestureState::Ready,
                            });
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
        let state = self
            .vision_gesture_status
            .filter(|status| status.request_id == request_id)
            .map(|status| status.state);
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
            return VOICE_GESTURES_HELD;
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
    fn ready_feedback_survives_partial_transcript_updates(cx: &mut TestAppContext) {
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
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_READY));

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
                });
            })
            .expect("window remains open");
        cx.run_until_parked();

        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_READY));
            assert_eq!(app.input.read(cx).value().as_ref(), "hello world");
            assert_eq!(
                app.vision_gesture_status,
                Some(VoiceGestureStatus {
                    request_id: 73,
                    state: GestureState::Ready,
                })
            );
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
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_READY));
                    assert_eq!(
                        app.vision_gesture_status,
                        Some(VoiceGestureStatus {
                            request_id: 74,
                            state: GestureState::Ready,
                        })
                    );

                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 12,
                            received_at: stale,
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::NeedsReady,
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
                            },
                        },
                        cx,
                    );
                    assert_eq!(app.voice_notice.as_deref(), Some(VOICE_GESTURES_NEED_READY));

                    // Helper state explains presentation but cannot latch the
                    // app-owned action state.
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 14,
                            received_at: Instant::now(),
                            status: ControlStatus::Active {
                                voice_request_id: 74,
                                state: GestureState::Holding,
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

                    app.handle_vision_event(
                        VisionEvent::Lifecycle(LifecycleState::Interrupted),
                        cx,
                    );
                    assert!(app.dictation_is_gesture_held());
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("LISTENING · SEND HELD · GESTURES UNAVAILABLE")
                    );
                });
            })
            .expect("window remains open");
    }
}
