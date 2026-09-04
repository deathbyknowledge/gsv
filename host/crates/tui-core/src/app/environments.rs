//! Capability environment selection and prompt rendering.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub(crate) fn matching_environment_indices(&self) -> Vec<usize> {
        let query = self.environment_query.trim();
        if query.is_empty() {
            return (0..self.environments.len()).collect();
        }
        let mut matches = self
            .environments
            .iter()
            .enumerate()
            .filter_map(|(index, environment)| {
                fuzzy_score(query, &environment.target)
                    .into_iter()
                    .chain(fuzzy_score(query, &environment.label))
                    .max()
                    .map(|score| (index, score))
            })
            .collect::<Vec<_>>();
        matches.sort_by(|(left_index, left_score), (right_index, right_score)| {
            right_score
                .cmp(left_score)
                .then_with(|| left_index.cmp(right_index))
        });
        matches.into_iter().map(|(index, _)| index).collect()
    }

    pub(crate) fn select_environment_choice(&mut self) {
        let matches = self.matching_environment_indices();
        if let Some(index) = matches.get(self.environment_choice).copied() {
            self.active_environment = index;
            self.close_environment_picker();
        }
    }

    pub(crate) fn close_environment_picker(&mut self) {
        self.environment_picker = false;
        self.environment_query.clear();
        self.environment_choice = 0;
    }

    pub(crate) fn default_environment(&self) -> &CapabilityEnvironment {
        &self.environments[0]
    }

    pub(crate) fn shell_prompt(&self, environment: &CapabilityEnvironment) -> Vec<Span<'static>> {
        let palette = self.theme.palette();
        let target = prompt_token(&environment.target, "gsv");
        let mut prompt = vec![
            Span::styled(self.principal.clone(), Style::new().fg(palette.principal)),
            Span::styled("@", Style::new().fg(palette.accent)),
            Span::styled(
                target,
                Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
            ),
        ];
        if let Some(cwd) = environment
            .cwd
            .as_deref()
            .filter(|cwd| !cwd.trim().is_empty())
        {
            prompt.extend([
                Span::raw(" "),
                Span::styled(sanitize_label(cwd, "~", 80), Style::new().fg(palette.path)),
            ]);
        }
        prompt.extend([
            Span::raw(" "),
            Span::styled(
                "$",
                Style::new()
                    .fg(palette.foreground)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" "),
        ]);
        prompt
    }

    pub(crate) fn input_prompt(
        &self,
        environment: &CapabilityEnvironment,
        execution: ExecutionMode,
    ) -> Vec<Span<'static>> {
        let mut prompt = self.shell_prompt(environment);
        if execution == ExecutionMode::Shell {
            let palette = self.theme.palette();
            prompt.extend([
                Span::styled(
                    "!",
                    Style::new()
                        .fg(palette.foreground)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" "),
            ]);
        }
        prompt
    }
}
