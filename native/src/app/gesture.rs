use std::time::{Duration, Instant};

use gpui::Context;
use gsv_vision_control::{GestureIntent, LifecycleState};

use crate::vision_debug::{VisionContext, VisionEvent};

use super::GsvApp;

const MAX_GESTURE_INTENT_AGE: Duration = Duration::from_secs(1);

impl GsvApp {
    /// Gives the helper a request-scoped action lease only after transcription
    /// has authoritatively entered its listening phase.
    pub(super) fn enable_vision_for_voice(&mut self, request_id: u64) {
        if !self.voice_request_accepts_gestures(request_id) {
            return;
        }
        self.vision_voice_request_id = Some(request_id);
        self.sync_vision_context();
    }

    /// Invalidates the action lease before the voice request is cleared. A
    /// queued event still carries the old request ID and is rejected below.
    pub(super) fn disable_vision_for_voice(&mut self, request_id: u64) {
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
                    // Failure never synthesizes a hold release. The keyboard
                    // remains available to finish or cancel dictation.
                    if self.dictation_is_gesture_held() {
                        self.voice_notice =
                            Some("LISTENING · SEND HELD · GESTURES UNAVAILABLE".to_string());
                    }
                } else {
                    self.sync_vision_context();
                }
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
                            self.voice_notice =
                                Some("LISTENING · SEND HELD · SHOW TWO OPEN PALMS".to_string());
                        }
                        changed
                    }
                    GestureIntent::ReleaseHold => {
                        let changed = self.gesture_release_dictation_hold(cx);
                        if changed {
                            self.voice_notice = Some("LISTENING · GESTURES READY".to_string());
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
