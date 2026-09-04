//! Agent action trail: tool starts, finishes, and the folded summary under each command.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub fn start_agent_action(
        &mut self,
        run_id: &str,
        execution_id: &str,
        name: &str,
        syscall: &str,
        target: Option<&str>,
    ) {
        self.start_agent_action_at(run_id, execution_id, name, syscall, target, None);
    }

    pub fn start_agent_action_at(
        &mut self,
        run_id: &str,
        execution_id: &str,
        name: &str,
        syscall: &str,
        target: Option<&str>,
        started_at: Option<u64>,
    ) {
        if run_id.is_empty()
            || execution_id.is_empty()
            || self
                .active_run
                .as_deref()
                .is_some_and(|active_run| active_run != run_id)
        {
            return;
        }
        self.start_run_at(run_id, started_at);

        let after_moment_id = started_at
            .is_none()
            .then(|| {
                self.moments
                    .iter()
                    .rfind(|moment| {
                        moment.run_id.as_deref() == Some(run_id)
                            && moment.state != MomentState::Streaming
                    })
                    .map(|moment| moment.id.clone())
            })
            .flatten();
        let label = agent_action_label(name, syscall);
        let target = target
            .map(|target| sanitize_label(target, "target", 64))
            .filter(|target| !target.trim().is_empty());
        let run_index = self.ensure_action_run(run_id, true);
        let run = &mut self.action_runs[run_index];
        run.live = true;
        run.expanded = true;
        if let Some(action) = run
            .actions
            .iter_mut()
            .find(|action| action.execution_id == execution_id)
        {
            action.label = label;
            action.target = target;
            if started_at.is_some() {
                action.started_at = started_at;
            }
            if action.after_moment_id.is_none() {
                action.after_moment_id = after_moment_id;
            }
            if action.state == AgentActionState::Running {
                self.set_activity_from_latest_action(run_id);
            }
            return;
        }
        if run.actions.len() >= MAX_ACTIONS_PER_RUN {
            run.actions.remove(0);
            run.omitted = run.omitted.saturating_add(1);
        }
        run.actions.push(AgentAction {
            execution_id: execution_id.to_string(),
            label,
            target,
            state: AgentActionState::Running,
            started_at,
            after_moment_id,
        });
        run.actions.sort_by(action_timeline_order);
        self.set_activity_from_latest_action(run_id);
    }

    pub fn finish_agent_action(&mut self, run_id: &str, execution_id: &str, outcome: &str) {
        let Some(run) = self.action_runs.iter_mut().find(|run| run.run_id == run_id) else {
            return;
        };
        let Some(action) = run
            .actions
            .iter_mut()
            .find(|action| action.execution_id == execution_id)
        else {
            return;
        };
        action.state = agent_action_state(outcome);
        self.set_activity_from_latest_action(run_id);
    }

    pub fn restore_agent_action(&mut self, snapshot: AgentActionSnapshot) {
        let AgentActionSnapshot {
            run_id,
            execution_id,
            name,
            syscall,
            target,
            status,
            live,
            started_at,
        } = snapshot;
        if run_id.is_empty() || execution_id.is_empty() {
            return;
        }
        let state = agent_action_state(&status);
        let live = live && state == AgentActionState::Running;
        if live {
            if self
                .active_run
                .as_deref()
                .is_some_and(|active_run| active_run != run_id.as_str())
            {
                return;
            }
            self.start_run(&run_id);
        }

        let label = agent_action_label(&name, &syscall);
        let target = target
            .map(|target| sanitize_label(&target, "target", 64))
            .filter(|target| !target.trim().is_empty());
        let run_index = self.ensure_action_run(&run_id, live);
        let run = &mut self.action_runs[run_index];
        run.live |= live;
        run.expanded |= live;
        if let Some(action) = run
            .actions
            .iter_mut()
            .find(|action| action.execution_id == execution_id)
        {
            action.label = label;
            action.target = target;
            if started_at.is_some() {
                action.started_at = started_at;
            }
            if action.state == AgentActionState::Running || state != AgentActionState::Running {
                action.state = state;
            }
        } else {
            if run.actions.len() >= MAX_ACTIONS_PER_RUN {
                run.actions.remove(0);
                run.omitted = run.omitted.saturating_add(1);
            }
            run.actions.push(AgentAction {
                execution_id,
                label,
                target,
                state,
                started_at,
                after_moment_id: None,
            });
        }
        run.actions.sort_by(action_timeline_order);
        if live {
            self.set_activity_from_latest_action(&run_id);
        }
    }

    pub fn restore_message_delivery(&mut self, delivery: MessageDeliverySnapshot) {
        if let Some(moment) = self.moments.iter_mut().find(|moment| {
            moment.id == delivery.message_id
                && moment.run_id.as_deref() == Some(delivery.run_id.as_str())
        }) {
            moment.timestamp = Some(delivery.started_at);
        }
    }

    pub(crate) fn ensure_action_run(&mut self, run_id: &str, live: bool) -> usize {
        if let Some(index) = self.action_runs.iter().position(|run| run.run_id == run_id) {
            return index;
        }
        if self.action_runs.len() >= MAX_ACTION_RUNS {
            let remove = self
                .action_runs
                .iter()
                .position(|run| !run.live)
                .unwrap_or(0);
            self.action_runs.remove(remove);
        }
        self.action_runs.push(RunActions {
            run_id: run_id.to_string(),
            actions: Vec::new(),
            omitted: 0,
            expanded: live,
            live,
        });
        self.action_runs.len() - 1
    }

    pub(crate) fn set_activity_from_latest_action(&mut self, run_id: &str) {
        if self.active_run.as_deref() != Some(run_id) {
            return;
        }
        self.activity = self
            .action_runs
            .iter()
            .find(|run| run.run_id == run_id)
            .and_then(|run| {
                run.actions
                    .iter()
                    .rev()
                    .find(|action| action.state == AgentActionState::Running)
            })
            .map(agent_action_status)
            .or_else(|| Some("THINKING".to_string()));
    }

    pub(crate) fn finish_action_run(&mut self, run_id: &str, failed: bool) {
        let Some(run) = self.action_runs.iter_mut().find(|run| run.run_id == run_id) else {
            return;
        };
        run.live = false;
        run.expanded = false;
        for action in &mut run.actions {
            if action.state == AgentActionState::Running {
                action.state = if failed {
                    AgentActionState::Failed
                } else {
                    AgentActionState::Completed
                };
            }
        }
    }

    pub(crate) fn toggle_selected_actions(&mut self) {
        if self.moments.is_empty() {
            return;
        }
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        let run_id = self.moments[start..=end]
            .iter()
            .find_map(|moment| moment.run_id.as_deref());
        let Some(run_id) = run_id else {
            return;
        };
        let Some(run) = self.action_runs.iter_mut().find(|run| run.run_id == run_id) else {
            return;
        };
        run.expanded = !run.expanded;
        if !self.follow_latest {
            self.scroll_anchor = Some(ScrollAnchor::Moment(start));
        }
    }

    pub(crate) fn run_has_active_action(&self, run_id: &str) -> bool {
        self.action_runs
            .iter()
            .find(|run| run.run_id == run_id)
            .is_some_and(|run| {
                run.actions
                    .iter()
                    .any(|action| action.state == AgentActionState::Running)
            })
    }

    pub(crate) fn push_action_run_segment(
        &self,
        rendered: &mut Vec<(String, usize)>,
        blocks: &mut Vec<TranscriptBlock>,
        document_height: &mut u16,
        request: ActionSegmentRequest<'_>,
    ) {
        let ActionSegmentRequest {
            run_id,
            width,
            activity_phase,
            cutoff,
            after_moment_id,
            flush,
        } = request;
        let Some(run) = self
            .action_runs
            .iter()
            .find(|run| run.run_id == run_id && !run.actions.is_empty())
        else {
            return;
        };
        let cursor_index = rendered
            .iter()
            .position(|(rendered_run_id, _)| rendered_run_id == run_id)
            .unwrap_or_else(|| {
                rendered.push((run_id.to_string(), 0));
                rendered.len() - 1
            });
        let cursor = rendered[cursor_index].1;
        if cursor >= run.actions.len() {
            return;
        }
        if !run.expanded {
            push_transcript_text(
                blocks,
                document_height,
                render_agent_action_summary(run, self.theme.palette(), activity_phase),
                width,
            );
            rendered[cursor_index].1 = run.actions.len();
            return;
        }

        let end = if flush {
            run.actions.len()
        } else if let Some(after_moment_id) = after_moment_id {
            run.actions[cursor..]
                .iter()
                .position(|action| action.after_moment_id.as_deref() != Some(after_moment_id))
                .map_or(run.actions.len(), |offset| cursor + offset)
        } else if let Some(cutoff) = cutoff {
            run.actions[cursor..]
                .iter()
                .position(|action| {
                    action
                        .started_at
                        .is_none_or(|started_at| started_at > cutoff)
                })
                .map_or(run.actions.len(), |offset| cursor + offset)
        } else {
            cursor
        };
        if end <= cursor {
            return;
        }
        let visible_start = if run.live {
            run.actions.len().saturating_sub(MAX_VISIBLE_LIVE_ACTIONS)
        } else {
            0
        };
        let start = cursor.max(visible_start);
        if end > start {
            let hidden = if cursor < visible_start {
                run.omitted.saturating_add(visible_start)
            } else {
                0
            };
            push_transcript_text(
                blocks,
                document_height,
                render_agent_action_segment(
                    &run.actions[start..end],
                    hidden,
                    self.theme.palette(),
                    activity_phase,
                ),
                width,
            );
        }
        rendered[cursor_index].1 = end;
    }
}
