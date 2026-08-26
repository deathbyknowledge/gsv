use gesture_protocol::LifecycleState;
use gpui::{Context, Window};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::model::ConnectionState;
use crate::system_status::{
    GatewayStatus, GestureStatus, MachineStatus, SystemStatusAction, SystemStatusSnapshot,
};
use crate::{client::ClientCommand, machine_setup::MachineRuntimeStatus};

use super::{GsvApp, ToggleDictation, ToggleGestureGuide};

impl GsvApp {
    pub(crate) fn attach_system_status_actions(
        &mut self,
        mut actions: UnboundedReceiver<SystemStatusAction>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self._system_status_task = Some(cx.spawn_in(window, async move |this, cx| {
            while let Some(action) = actions.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.handle_system_status_action(action, window, cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    pub(crate) fn system_status_snapshot(&self) -> SystemStatusSnapshot {
        let gateway = if self.login.is_some() {
            GatewayStatus::SignedOut
        } else if self.client_session_id.is_some()
            && self.conversation.connection == ConnectionState::Connected
        {
            GatewayStatus::Connected
        } else {
            GatewayStatus::Connecting
        };
        let gestures = match (self.vision_context.is_some(), self.vision_lifecycle) {
            (_, Some(LifecycleState::Ready)) if self.vision_armed => GestureStatus::Armed,
            (_, Some(LifecycleState::Ready)) => GestureStatus::Disarmed,
            (true, None) => GestureStatus::Starting,
            (false, None) => GestureStatus::Disabled,
            _ => GestureStatus::Unavailable,
        };
        SystemStatusSnapshot {
            gateway,
            machine: if self.machine_configured {
                match self.machine_runtime_status {
                    MachineRuntimeStatus::NotRunning => MachineStatus::NotRunning,
                    MachineRuntimeStatus::Starting => MachineStatus::Starting,
                    MachineRuntimeStatus::Connecting => MachineStatus::Connecting,
                    MachineRuntimeStatus::Connected => MachineStatus::Connected,
                    MachineRuntimeStatus::Reconnecting => MachineStatus::Reconnecting,
                    MachineRuntimeStatus::Reloading => MachineStatus::Reloading,
                    MachineRuntimeStatus::ShuttingDown => MachineStatus::ShuttingDown,
                }
            } else {
                MachineStatus::NotSetUp
            },
            voice_active: self.voice_draft.is_some(),
            voice_available: self.voice_draft.is_some() || self.dictation_start_is_safe(),
            gestures,
        }
    }

    fn handle_system_status_action(
        &mut self,
        action: SystemStatusAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            SystemStatusAction::Open => {
                cx.activate(true);
                window.activate_window();
                self.focus_active_input(window, cx);
            }
            SystemStatusAction::Gateway => {
                cx.activate(true);
                window.activate_window();
                self.focus_active_input(window, cx);
                if self.login.is_none() {
                    let _ = self.commands.send(ClientCommand::ReconnectGateway);
                }
            }
            SystemStatusAction::MachinePrimary => {
                cx.activate(true);
                window.activate_window();
                if !self.machine_configured {
                    self.machine_setup_dismissed = false;
                    self.begin_machine_management(
                        false,
                        crate::machine_setup::suggested_machine_name(),
                        window,
                        cx,
                    );
                } else {
                    let command = match self.machine_runtime_status {
                        MachineRuntimeStatus::NotRunning => {
                            self.machine_runtime_status = MachineRuntimeStatus::Starting;
                            Some(ClientCommand::StartMachine)
                        }
                        MachineRuntimeStatus::Connecting
                        | MachineRuntimeStatus::Connected
                        | MachineRuntimeStatus::Reconnecting
                        | MachineRuntimeStatus::Reloading => {
                            self.machine_runtime_status = MachineRuntimeStatus::Reconnecting;
                            Some(ClientCommand::ReconnectMachine)
                        }
                        MachineRuntimeStatus::Starting | MachineRuntimeStatus::ShuttingDown => None,
                    };
                    if let Some(command) = command {
                        let _ = self.commands.send(command);
                    }
                    self.focus_active_input(window, cx);
                }
                cx.notify();
            }
            SystemStatusAction::MachineRestart => {
                self.machine_runtime_status = MachineRuntimeStatus::Starting;
                let _ = self.commands.send(ClientCommand::RestartMachine);
                cx.notify();
            }
            SystemStatusAction::MachineDiagnostics => {
                cx.activate(true);
                window.activate_window();
                self.focus_active_input(window, cx);
                let _ = self.commands.send(ClientCommand::DiagnoseMachine);
            }
            SystemStatusAction::ToggleVoice => {
                self.toggle_dictation_action(&ToggleDictation, window, cx);
            }
            SystemStatusAction::OpenGestureGuide => {
                cx.activate(true);
                window.activate_window();
                self.toggle_gesture_guide_action(&ToggleGestureGuide, window, cx);
            }
            SystemStatusAction::Quit => cx.quit(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{AppContext as _, TestAppContext, WindowOptions};
    use gpui_component::Root;

    use crate::app::{bind_keys, GsvApp};
    use crate::client;

    use super::*;

    #[gpui::test]
    fn demo_status_is_connected_and_keeps_gestures_disabled(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let _window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view =
                    cx.new(|cx| GsvApp::new(window, cx, client::start(true), true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("test window")
        });
        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).system_status_snapshot(),
                SystemStatusSnapshot {
                    gateway: GatewayStatus::Connecting,
                    machine: MachineStatus::Connected,
                    voice_active: false,
                    voice_available: true,
                    gestures: GestureStatus::Disabled,
                }
            );
        });
    }
}
