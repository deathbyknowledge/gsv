use std::time::{Duration, Instant};

use gpui::{Context, Window};
use gsv_vision_control::{
    ControlStatus, GestureCandidate, GestureContext, GestureIntent, GestureProgress,
    LifecycleState, VoiceRequestGestureIntent,
};

use crate::vision_debug::{VisionContext, VisionEvent};

use super::{GsvApp, VoiceGestureStatus};

const MAX_GESTURE_INTENT_AGE: Duration = Duration::from_secs(1);
const MAX_GESTURE_STATUS_AGE: Duration = Duration::from_secs(1);

const GESTURES_STARTING: &str = "GESTURE TRANSCRIPTION · STARTING";
const GESTURES_STANDBY: &str = "GESTURE TRANSCRIPTION · STANDBY";
const GESTURES_HOLD_TO_START: &str = "GESTURE TRANSCRIPTION · HOLD TO START";
const GESTURES_UNAVAILABLE: &str = "GESTURE TRANSCRIPTION · UNAVAILABLE";
const VOICE_GESTURES_DISABLED: &str = "LISTENING · SPEAK NOW · PRESS AGAIN TO FINISH";
const VOICE_GESTURES_STARTING: &str = "LISTENING · GESTURES STARTING";
const VOICE_GESTURES_UNAVAILABLE: &str = "LISTENING · GESTURES UNAVAILABLE · PRESS AGAIN TO FINISH";
const VOICE_GESTURES_ACTIVE: &str = "LISTENING · GESTURES ACTIVE";
const VOICE_GESTURES_MUTED: &str = "LISTENING · MICROPHONE MUTED";
const VOICE_GESTURE_STOP: &str = "LISTENING · HOLD TO FINISH";
const VOICE_GESTURE_SEND: &str = "LISTENING · HOLD TO SEND";
const VOICE_GESTURE_MUTE: &str = "LISTENING · HOLD TO MUTE";
const VOICE_GESTURE_UNMUTE: &str = "LISTENING · HOLD TO UNMUTE";
const VOICE_GESTURE_MUTING: &str = "LISTENING · MUTING MICROPHONE";
const VOICE_GESTURE_UNMUTING: &str = "LISTENING · UNMUTING MICROPHONE";

impl GsvApp {
    /// Claims one Desktop-owned voice request for eventual gesture actions.
    /// A newly accepted transcription remains Disabled until Listening and
    /// its initial MuteState have both become authoritative.
    pub(super) fn begin_vision_for_voice(&mut self, request_id: u64) {
        if self.vision_context.is_none() || self.active_voice_request_id() != Some(request_id) {
            return;
        }
        if self.vision_voice_request_id != Some(request_id) {
            self.vision_voice_request_id = Some(request_id);
            self.clear_voice_gesture_status();
        }
        self.sync_vision_context();
    }

    /// Recomputes the exact request lease after authoritative transcription
    /// state changes. This promotes Disabled to Active only when every
    /// request-scoped action precondition is known.
    pub(super) fn enable_vision_for_voice(&mut self, request_id: u64) {
        if self.vision_context.is_none()
            || self.active_voice_request_id() != Some(request_id)
            || self
                .vision_lifecycle
                .is_some_and(|state| state != LifecycleState::Ready)
        {
            return;
        }
        if self.vision_voice_request_id != Some(request_id) {
            self.vision_voice_request_id = Some(request_id);
            self.clear_voice_gesture_status();
        }
        self.sync_vision_context();
    }

    /// Revokes the helper's request lease before a terminal transition. The
    /// presence of a VoiceDraft keeps the context Disabled until the matching
    /// Final, Cancelled, or Error event clears the request and restores
    /// Standby.
    pub(super) fn disable_vision_for_voice(&mut self, request_id: u64) {
        if self.vision_gesture_status.is_some_and(|status| {
            matches!(
                status.context,
                GestureContext::Active {
                    voice_request_id,
                    ..
                } if voice_request_id == request_id
            )
        }) {
            self.clear_voice_gesture_status();
        }
        if self.vision_voice_request_id == Some(request_id) {
            self.vision_voice_request_id = None;
        }
        self.sync_vision_context();
    }

    pub(super) fn initialize_vision_context(&mut self) {
        self.sync_vision_context();
        self.refresh_idle_vision_notice();
    }

    pub(super) fn handle_vision_event(
        &mut self,
        event: VisionEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.handle_vision_event_with_window_state(event, window.is_window_active(), window, cx);
    }

    fn handle_vision_event_with_window_state(
        &mut self,
        event: VisionEvent,
        window_is_active: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            VisionEvent::Lifecycle(state) => {
                self.vision_lifecycle = Some(state);
                if state != LifecycleState::Ready {
                    if let Some(request_id) = self.vision_voice_request_id {
                        self.disable_vision_for_voice(request_id);
                    }
                    self.clear_voice_gesture_status();
                }
                self.sync_vision_context();
                self.refresh_voice_gesture_notice();
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
                let (context, progress) = status_context(status);
                let current_context = self.current_vision_context();
                if Instant::now().saturating_duration_since(received_at) > MAX_GESTURE_STATUS_AGE {
                    if context == current_context {
                        self.clear_voice_gesture_status();
                        self.refresh_voice_gesture_notice();
                        cx.notify();
                    }
                    return;
                }
                if self.vision_lifecycle != Some(LifecycleState::Ready)
                    || context != current_context
                    || context == GestureContext::Disabled
                {
                    return;
                }
                self.set_voice_gesture_status(
                    VoiceGestureStatus {
                        sequence,
                        received_at,
                        context,
                        progress,
                    },
                    cx,
                );
                self.refresh_voice_gesture_notice();
                cx.notify();
            }
            VisionEvent::Intent {
                sequence: _,
                received_at,
                intent,
            } => {
                let fresh =
                    Instant::now().saturating_duration_since(received_at) <= MAX_GESTURE_INTENT_AGE;
                let ready = self.vision_lifecycle == Some(LifecycleState::Ready);

                match intent {
                    GestureIntent::StartTranscription => {
                        let eligible = fresh
                            && ready
                            && self.current_vision_context() == GestureContext::Standby
                            && window_is_active
                            && self.dictation_start_is_safe();
                        if eligible {
                            self.start_dictation(window, cx);
                        }
                    }
                    GestureIntent::VoiceRequest {
                        voice_request_id,
                        action,
                    } => {
                        let owns_request = self.vision_voice_request_id == Some(voice_request_id)
                            && self.active_voice_request_id() == Some(voice_request_id);
                        if fresh && ready && owns_request {
                            match action {
                                VoiceRequestGestureIntent::StopTranscription => {
                                    if self.voice_request_can_stop(voice_request_id) {
                                        self.disable_vision_for_voice(voice_request_id);
                                        self.finish_dictation(cx);
                                    }
                                }
                                VoiceRequestGestureIntent::Send
                                    if self.voice_request_accepts_gestures(voice_request_id) =>
                                {
                                    self.gesture_send_dictation_now(cx);
                                }
                                VoiceRequestGestureIntent::Mute
                                    if self.voice_request_accepts_gestures(voice_request_id) =>
                                {
                                    self.gesture_set_dictation_muted(true, cx);
                                }
                                VoiceRequestGestureIntent::Unmute
                                    if self.voice_request_accepts_gestures(voice_request_id) =>
                                {
                                    self.gesture_set_dictation_muted(false, cx);
                                }
                                VoiceRequestGestureIntent::Send
                                | VoiceRequestGestureIntent::Mute
                                | VoiceRequestGestureIntent::Unmute => {}
                            }
                        }
                    }
                }

                // Reliable actions supersede explanatory status. Rejected and
                // idempotent intents receive a fresh absolute authority echo.
                // Accepted mute/send actions remain pending until their exact
                // MuteState/SegmentFinal completion, so replaying the old
                // state here would acknowledge them prematurely.
                self.clear_voice_gesture_status();
                if self.dictation_pending_mute().is_none()
                    && !self.dictation_segment_commit_is_pending()
                {
                    self.reassert_vision_context();
                }
                self.refresh_voice_gesture_notice();
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

    pub(super) fn reassert_vision_context(&self) {
        let Some(sender) = &self.vision_context else {
            return;
        };
        let _ = sender.reassert_context(self.current_vision_context());
    }

    fn current_vision_context(&self) -> VisionContext {
        if let Some(request_id) = self
            .vision_voice_request_id
            .filter(|request_id| self.active_voice_request_id() == Some(*request_id))
        {
            return if self.voice_request_has_active_gesture_context(request_id) {
                VisionContext::Active {
                    voice_request_id: request_id,
                    muted: self.dictation_is_muted(),
                }
            } else {
                VisionContext::Disabled
            };
        }

        if self.active_voice_request_id().is_some()
            || self.microphone_chooser.is_some()
            || self.pending_microphone_request.is_some()
            || self.microphone_save_pending
        {
            VisionContext::Disabled
        } else {
            VisionContext::Standby
        }
    }

    pub(super) fn listening_voice_notice(&self, request_id: u64) -> &'static str {
        if let Some(pending_mute) = self.dictation_pending_mute() {
            return if pending_mute {
                VOICE_GESTURE_MUTING
            } else {
                VOICE_GESTURE_UNMUTING
            };
        }

        let muted = self.dictation_is_muted();
        if self.vision_context.is_none() {
            return if self.vision_lifecycle.is_some() {
                VOICE_GESTURES_UNAVAILABLE
            } else {
                VOICE_GESTURES_DISABLED
            };
        }
        if self.vision_lifecycle != Some(LifecycleState::Ready) {
            return if self.vision_lifecycle.is_none() {
                VOICE_GESTURES_STARTING
            } else {
                VOICE_GESTURES_UNAVAILABLE
            };
        }
        if !self.voice_request_accepts_gestures(request_id) {
            return VOICE_GESTURES_STARTING;
        }
        if let Some(progress) = self.voice_gesture_progress(GestureContext::Active {
            voice_request_id: request_id,
            muted,
        }) {
            return match progress.candidate() {
                GestureCandidate::StopTranscription => VOICE_GESTURE_STOP,
                GestureCandidate::Send => VOICE_GESTURE_SEND,
                GestureCandidate::Mute => VOICE_GESTURE_MUTE,
                GestureCandidate::Unmute => VOICE_GESTURE_UNMUTE,
                GestureCandidate::StartTranscription => VOICE_GESTURES_ACTIVE,
            };
        }
        if muted {
            VOICE_GESTURES_MUTED
        } else {
            VOICE_GESTURES_ACTIVE
        }
    }

    /// Returns only fresh presentation progress that matches Desktop's
    /// current absolute context. Status can animate UI but never invokes an
    /// action.
    pub(super) fn visible_voice_gesture_progress(&self) -> Option<GestureProgress> {
        let context = self.current_vision_context();
        if self.vision_lifecycle != Some(LifecycleState::Ready)
            || context == GestureContext::Disabled
            || self.dictation_pending_mute().is_some()
            || self.dictation_segment_commit_is_pending()
        {
            return None;
        }
        self.voice_gesture_progress(context)
    }

    fn voice_gesture_progress(&self, context: GestureContext) -> Option<GestureProgress> {
        let status = self.fresh_voice_gesture_status(context)?;
        let progress = status.progress?;
        progress.is_compatible_with(context).then_some(progress)
    }

    fn fresh_voice_gesture_status(&self, context: GestureContext) -> Option<VoiceGestureStatus> {
        self.vision_gesture_status.filter(|status| {
            status.context == context
                && Instant::now().saturating_duration_since(status.received_at)
                    < MAX_GESTURE_STATUS_AGE
        })
    }

    fn set_voice_gesture_status(&mut self, status: VoiceGestureStatus, cx: &mut Context<Self>) {
        let age = Instant::now().saturating_duration_since(status.received_at);
        let expires_in = MAX_GESTURE_STATUS_AGE.saturating_sub(age);
        let context = status.context;
        let sequence = status.sequence;
        let received_at = status.received_at;
        self.vision_gesture_status = Some(status);

        let timer = cx.background_executor().timer(expires_in);
        self.vision_gesture_expiry_task = Some(cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |this, cx| {
                let still_current = this.vision_gesture_status.is_some_and(|current| {
                    current.context == context
                        && current.sequence == sequence
                        && current.received_at == received_at
                });
                if still_current {
                    this.vision_gesture_status = None;
                    this.refresh_voice_gesture_notice();
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
        self.refresh_voice_gesture_notice();
    }

    pub(super) fn refresh_idle_vision_notice(&mut self) {
        if self.active_voice_request_id().is_some()
            || self.microphone_chooser.is_some()
            || self.pending_microphone_request.is_some()
            || self.microphone_save_pending
        {
            return;
        }
        if self.voice_notice.as_deref().is_some_and(|notice| {
            !matches!(
                notice,
                GESTURES_STARTING
                    | GESTURES_STANDBY
                    | GESTURES_HOLD_TO_START
                    | GESTURES_UNAVAILABLE
            )
        }) {
            // Voice/microphone owners keep their actionable result until an
            // ordinary user operation replaces it. Presentation-only helper
            // status must never erase an error or terminal outcome.
            return;
        }
        self.voice_notice = if self.vision_context.is_none() {
            self.vision_lifecycle
                .is_some()
                .then(|| GESTURES_UNAVAILABLE.to_string())
        } else {
            Some(
                match self.vision_lifecycle {
                    Some(LifecycleState::Ready) => {
                        if self
                            .voice_gesture_progress(GestureContext::Standby)
                            .is_some_and(|progress| {
                                progress.candidate() == GestureCandidate::StartTranscription
                            })
                        {
                            GESTURES_HOLD_TO_START
                        } else {
                            GESTURES_STANDBY
                        }
                    }
                    None => GESTURES_STARTING,
                    Some(_) => GESTURES_UNAVAILABLE,
                }
                .to_string(),
            )
        };
    }

    fn refresh_voice_gesture_notice(&mut self) {
        if let Some(request_id) = self.active_voice_request_id() {
            if self.voice_request_is_stopping(request_id) {
                return;
            }
            if self.voice_request_is_listening(request_id) {
                self.voice_notice = Some(self.listening_voice_notice(request_id).to_string());
            } else if self
                .vision_lifecycle
                .is_some_and(|state| state != LifecycleState::Ready)
            {
                self.voice_notice =
                    Some("PREPARING VOICE INPUT · GESTURES UNAVAILABLE".to_string());
            }
            return;
        }
        self.refresh_idle_vision_notice();
    }
}

fn status_context(status: ControlStatus) -> (GestureContext, Option<GestureProgress>) {
    match status {
        ControlStatus::Disabled => (GestureContext::Disabled, None),
        ControlStatus::Standby { progress } => (GestureContext::Standby, progress),
        ControlStatus::Active {
            voice_request_id,
            muted,
            progress,
        } => (
            GestureContext::Active {
                voice_request_id,
                muted,
            },
            progress,
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{AppContext as _, Entity, TestAppContext, WindowOptions};
    use gpui_component::Root;
    use gsv_config::MicrophonePreference;

    use crate::client::{ClientCommand, ClientHandle};
    use crate::transcription::{VoiceCommand, VoiceEvent, VoicePhase};

    use super::*;

    fn open_test_app(
        cx: &mut TestAppContext,
    ) -> (
        Entity<GsvApp>,
        gpui::AnyWindowHandle,
        tokio::sync::mpsc::UnboundedReceiver<ClientCommand>,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::app::bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = Rc::clone(&app);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let app = app.borrow().clone().expect("app entity should be retained");
        (app, window.into(), command_rx)
    }

    fn install_ready_vision(
        app: &Entity<GsvApp>,
        window: gpui::AnyWindowHandle,
        cx: &mut TestAppContext,
    ) -> (
        crate::vision_debug::VisionContextSender,
        std::sync::mpsc::Receiver<VoiceCommand>,
    ) {
        let context = crate::vision_debug::VisionContextSender::for_test();
        let returned_context = context.clone();
        let (voice_commands, voice_events) =
            crate::transcription::VoiceCommandSender::channel_for_test();
        window
            .update(cx, |_, _, cx| {
                app.update(cx, |app, _cx| {
                    app.vision_context = Some(context);
                    app.vision_lifecycle = Some(LifecycleState::Ready);
                    app.microphone_preference = MicrophonePreference::SystemDefault;
                    app.voice_commands = voice_commands;
                    app.sync_vision_context();
                });
            })
            .expect("window remains open");
        (returned_context, voice_events)
    }

    fn start_and_activate(
        app: &Entity<GsvApp>,
        window: gpui::AnyWindowHandle,
        cx: &mut TestAppContext,
        request_id: u64,
    ) {
        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_voice_event(
                        VoiceEvent::State {
                            request_id,
                            phase: VoicePhase::Listening,
                            progress: None,
                        },
                        window,
                        cx,
                    );
                    app.handle_voice_event(
                        VoiceEvent::MuteState {
                            request_id,
                            revision: 0,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");
    }

    #[gpui::test]
    fn gesture_start_uses_the_desktop_owned_start_path(cx: &mut TestAppContext) {
        let (app, window, _client_commands) = open_test_app(cx);
        let (context, voice_events) = install_ready_vision(&app, window, cx);

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    assert_eq!(context.context_for_test(), GestureContext::Standby);
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            intent: GestureIntent::StartTranscription,
                        },
                        true,
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");

        assert!(matches!(
            voice_events.try_recv(),
            Ok(VoiceCommand::Start { request_id: 1, .. })
        ));
        assert_eq!(context.context_for_test(), GestureContext::Disabled);
        start_and_activate(&app, window, cx, 1);
        assert_eq!(
            context.context_for_test(),
            GestureContext::Active {
                voice_request_id: 1,
                muted: false,
            }
        );
    }

    #[gpui::test]
    fn keyboard_start_immediately_echoes_owned_starting_context(cx: &mut TestAppContext) {
        let (app, window, _client_commands) = open_test_app(cx);
        let (context, voice_events) = install_ready_vision(&app, window, cx);

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.toggle_dictation_action(&crate::app::ToggleDictation, window, cx);
                });
            })
            .expect("window remains open");

        assert!(matches!(
            voice_events.try_recv(),
            Ok(VoiceCommand::Start { request_id: 1, .. })
        ));
        assert_eq!(context.context_for_test(), GestureContext::Disabled);
    }

    #[gpui::test]
    fn stale_and_unsafe_start_intents_are_ignored_and_status_is_presentation_only(
        cx: &mut TestAppContext,
    ) {
        let (app, window, _client_commands) = open_test_app(cx);
        let (context, voice_events) = install_ready_vision(&app, window, cx);
        let stale = Instant::now()
            .checked_sub(MAX_GESTURE_INTENT_AGE + Duration::from_millis(1))
            .expect("test instant supports a short subtraction");
        let progress = GestureProgress::new(GestureCandidate::StartTranscription, 500)
            .expect("bounded test progress");

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 1,
                            received_at: Instant::now(),
                            status: ControlStatus::Standby {
                                progress: Some(progress),
                            },
                        },
                        window,
                        cx,
                    );
                    assert!(app.voice_draft.is_none());
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 2,
                            received_at: Instant::now(),
                            intent: GestureIntent::StartTranscription,
                        },
                        false,
                        window,
                        cx,
                    );
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 3,
                            received_at: stale,
                            intent: GestureIntent::StartTranscription,
                        },
                        true,
                        window,
                        cx,
                    );
                    app.desktop_switch_pending = true;
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 4,
                            received_at: Instant::now(),
                            intent: GestureIntent::StartTranscription,
                        },
                        true,
                        window,
                        cx,
                    );
                    assert!(app.voice_draft.is_none());
                });
            })
            .expect("window remains open");

        assert!(voice_events.try_recv().is_err());
        assert_eq!(context.context_for_test(), GestureContext::Standby);
    }

    #[gpui::test]
    fn stale_and_mismatched_active_intents_are_ignored(cx: &mut TestAppContext) {
        let (app, window, _client_commands) = open_test_app(cx);
        let (context, voice_events) = install_ready_vision(&app, window, cx);
        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| app.start_dictation(window, cx));
            })
            .expect("window remains open");
        assert!(matches!(
            voice_events.try_recv(),
            Ok(VoiceCommand::Start { request_id: 1, .. })
        ));
        start_and_activate(&app, window, cx, 1);
        let stale = Instant::now()
            .checked_sub(MAX_GESTURE_INTENT_AGE + Duration::from_millis(1))
            .expect("test instant supports a short subtraction");

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: stale,
                            intent: GestureIntent::VoiceRequest {
                                voice_request_id: 1,
                                action: VoiceRequestGestureIntent::StopTranscription,
                            },
                        },
                        false,
                        window,
                        cx,
                    );
                    assert!(app.voice_request_can_stop(1));
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 2,
                            received_at: Instant::now(),
                            intent: GestureIntent::VoiceRequest {
                                voice_request_id: 2,
                                action: VoiceRequestGestureIntent::Send,
                            },
                        },
                        true,
                        window,
                        cx,
                    );
                    assert!(!app.dictation_segment_commit_is_pending());

                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 3,
                            received_at: Instant::now(),
                            intent: GestureIntent::VoiceRequest {
                                voice_request_id: 2,
                                action: VoiceRequestGestureIntent::Mute,
                            },
                        },
                        true,
                        window,
                        cx,
                    );
                    assert_eq!(app.dictation_pending_mute(), None);
                    assert!(app.voice_request_can_stop(1));
                    assert!(!app.dictation_is_muted());
                    assert!(!app.dictation_segment_commit_is_pending());
                });
            })
            .expect("window remains open");

        assert!(voice_events.try_recv().is_err());
        assert_eq!(
            context.context_for_test(),
            GestureContext::Active {
                voice_request_id: 1,
                muted: false,
            }
        );
    }

    #[gpui::test]
    fn stop_preserves_unsent_final_as_a_draft_and_restores_standby(cx: &mut TestAppContext) {
        let (app, window, mut client_commands) = open_test_app(cx);
        let (context, voice_events) = install_ready_vision(&app, window, cx);
        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.start_dictation(window, cx);
                });
            })
            .expect("window remains open");
        assert!(matches!(
            voice_events.try_recv(),
            Ok(VoiceCommand::Start { request_id: 1, .. })
        ));
        start_and_activate(&app, window, cx, 1);

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_voice_event(
                        VoiceEvent::Partial {
                            request_id: 1,
                            segment_id: 0,
                            revision: 1,
                            committed: "unsent final words".to_string(),
                            tentative: String::new(),
                        },
                        window,
                        cx,
                    );
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            intent: GestureIntent::VoiceRequest {
                                voice_request_id: 1,
                                action: VoiceRequestGestureIntent::StopTranscription,
                            },
                        },
                        false,
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");
        assert_eq!(
            voice_events.try_recv(),
            Ok(VoiceCommand::Stop { request_id: 1 })
        );
        assert_eq!(context.context_for_test(), GestureContext::Disabled);

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_voice_event(
                        VoiceEvent::Final {
                            request_id: 1,
                            text: "unsent final words".to_string(),
                        },
                        window,
                        cx,
                    );
                    assert_eq!(app.input.read(cx).value().as_ref(), "unsent final words");
                    assert!(app.voice_draft.is_none());
                });
            })
            .expect("window remains open");
        assert_eq!(context.context_for_test(), GestureContext::Standby);
        assert!(client_commands.try_recv().is_err());
    }

    #[gpui::test]
    fn lifecycle_loss_revokes_actions_without_ending_transcription(cx: &mut TestAppContext) {
        let (app, window, _client_commands) = open_test_app(cx);
        let (context, voice_events) = install_ready_vision(&app, window, cx);
        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.start_dictation(window, cx);
                });
            })
            .expect("window remains open");
        let _ = voice_events.try_recv();
        start_and_activate(&app, window, cx, 1);

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_vision_event(
                        VisionEvent::Lifecycle(LifecycleState::Interrupted),
                        window,
                        cx,
                    );
                    assert!(app.voice_draft.is_some());
                    assert!(app.vision_voice_request_id.is_none());
                    app.handle_vision_event(
                        VisionEvent::Intent {
                            sequence: 2,
                            received_at: Instant::now(),
                            intent: GestureIntent::VoiceRequest {
                                voice_request_id: 1,
                                action: VoiceRequestGestureIntent::StopTranscription,
                            },
                        },
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");
        assert_eq!(context.context_for_test(), GestureContext::Disabled);
        assert!(voice_events.try_recv().is_err());
    }

    #[gpui::test]
    fn start_command_failure_reasserts_standby(cx: &mut TestAppContext) {
        let (app, window, _client_commands) = open_test_app(cx);
        let context = crate::vision_debug::VisionContextSender::for_test();
        let returned_context = context.clone();
        let (voice_commands, voice_events) =
            crate::transcription::VoiceCommandSender::channel_for_test();
        drop(voice_events);
        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.vision_context = Some(context);
                    app.vision_lifecycle = Some(LifecycleState::Ready);
                    app.microphone_preference = MicrophonePreference::SystemDefault;
                    app.voice_commands = voice_commands;
                    app.sync_vision_context();
                    let revision = returned_context.revision_for_test();
                    app.handle_vision_event_with_window_state(
                        VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            intent: GestureIntent::StartTranscription,
                        },
                        true,
                        window,
                        cx,
                    );
                    assert!(app.voice_draft.is_none());
                    assert!(returned_context.revision_for_test() > revision);
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("VOICE INPUT UNAVAILABLE · KEEP TYPING")
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 2,
                            received_at: Instant::now(),
                            status: ControlStatus::Standby { progress: None },
                        },
                        window,
                        cx,
                    );
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("VOICE INPUT UNAVAILABLE · KEEP TYPING")
                    );
                });
            })
            .expect("window remains open");
        assert_eq!(returned_context.context_for_test(), GestureContext::Standby);
    }

    #[gpui::test]
    fn standby_status_does_not_erase_a_no_speech_terminal_outcome(cx: &mut TestAppContext) {
        let (app, window, _client_commands) = open_test_app(cx);
        let (context, voice_events) = install_ready_vision(&app, window, cx);
        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.start_dictation(window, cx);
                });
            })
            .expect("window remains open");
        assert!(matches!(
            voice_events.try_recv(),
            Ok(VoiceCommand::Start { request_id: 1, .. })
        ));
        start_and_activate(&app, window, cx, 1);

        window
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.finish_dictation(cx);
                    app.handle_voice_event(
                        VoiceEvent::Final {
                            request_id: 1,
                            text: String::new(),
                        },
                        window,
                        cx,
                    );
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("NO SPEECH HEARD · CHECK INPUT")
                    );
                    app.handle_vision_event(
                        VisionEvent::Status {
                            sequence: 3,
                            received_at: Instant::now(),
                            status: ControlStatus::Standby { progress: None },
                        },
                        window,
                        cx,
                    );
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("NO SPEECH HEARD · CHECK INPUT")
                    );
                });
            })
            .expect("window remains open");
        assert_eq!(
            voice_events.try_recv(),
            Ok(VoiceCommand::Stop { request_id: 1 })
        );
        assert_eq!(context.context_for_test(), GestureContext::Standby);
    }
}
